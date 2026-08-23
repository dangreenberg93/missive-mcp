/**
 * Draft tools: list, create, send, and delete drafts
 * Includes rate limiting for send operations
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import type { ClientResolver } from '../types/tools.js';
import { RateLimitError } from '../errors.js';
import type { MissiveClient } from '../client.js';
import type {
  DraftsResponse,
  DraftResponse,
  MessageResponse,
  UsersResponse,
} from '../types/missive.js';

/**
 * Rate limiter for send operations
 */
class SendRateLimiter {
  private sends: number[] = [];
  private readonly maxPerMinute = 10;
  private readonly maxPerHour = 100;

  canSend(): boolean {
    const now = Date.now();
    this.sends = this.sends.filter((t) => t > now - 3600000); // Keep last hour

    const lastMinute = this.sends.filter((t) => t > now - 60000).length;
    if (lastMinute >= this.maxPerMinute) {
      return false;
    }
    if (this.sends.length >= this.maxPerHour) {
      return false;
    }

    return true;
  }

  recordSend(): void {
    this.sends.push(Date.now());
  }

  getWaitTime(): number {
    const now = Date.now();
    this.sends = this.sends.filter((t) => t > now - 3600000);

    const lastMinute = this.sends.filter((t) => t > now - 60000);
    if (lastMinute.length >= this.maxPerMinute && lastMinute.length > 0) {
      return 60000 - (now - lastMinute[0]);
    }

    if (this.sends.length >= this.maxPerHour && this.sends.length > 0) {
      return 3600000 - (now - this.sends[0]);
    }

    return 0;
  }
}

// Per-user rate limiters
const rateLimiters = new Map<string, SendRateLimiter>();

function getRateLimiter(extra: { authInfo?: { extra?: Record<string, unknown> } }): SendRateLimiter {
  const userId = (extra.authInfo?.extra?.userId as string) || 'default';
  let limiter = rateLimiters.get(userId);
  if (!limiter) {
    limiter = new SendRateLimiter();
    rateLimiters.set(userId, limiter);
  }
  return limiter;
}

/**
 * Fresh email-address object schema.
 *
 * Do not reuse a single Zod object instance across fields. zod-to-json-schema
 * emits `$ref: "#/properties/to_fields/items"` for later uses, and many MCP
 * clients cannot resolve those refs, so they then reject every `from_field` value.
 */
function emailAddressObjectSchema() {
  return z.object({
    address: z
      .string()
      .email()
      .describe('Email address, e.g. ops@example.com'),
    name: z.string().optional().describe('Display name'),
  });
}

function coerceFromField(val: unknown): unknown {
  if (val == null || val === '') return undefined;

  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        return coerceFromField(JSON.parse(trimmed));
      } catch {
        return trimmed;
      }
    }
    const angle = trimmed.match(/^(?:"?([^"<]*)"?\s*)?<([^<>]+@[^<>]+)>$/);
    if (angle) {
      const name = angle[1]?.trim();
      const address = angle[2].trim();
      return name ? { address, name } : { address };
    }
    return trimmed;
  }

  if (Array.isArray(val) && val.length === 1) {
    return coerceFromField(val[0]);
  }

  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    const address = obj.address ?? obj.email;
    if (typeof address === 'string' && address.trim()) {
      const name =
        typeof obj.name === 'string' && obj.name.trim()
          ? obj.name.trim()
          : undefined;
      return name
        ? { address: address.trim(), name }
        : { address: address.trim() };
    }
  }

  return val;
}

const fromFieldSchema = z.preprocess(
  coerceFromField,
  z
    .union([
      z
        .string()
        .email()
        .describe('Sender email address, e.g. ops@example.com'),
      emailAddressObjectSchema(),
    ])
    .optional()
).describe(
  'Sender email. Must match a Missive account or alias you can send from (e.g. ops@example.com). Pass the address as a string, or {address, name}. Uses your default account if omitted.'
);

type FromFieldInput = string | { address: string; name?: string };

function normalizeFromField(
  value: FromFieldInput | undefined
): { address: string; name?: string } | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value === 'string') return { address: value };
  return value.name
    ? { address: value.address, name: value.name }
    : { address: value.address };
}

type NormalizedFromField = { address: string; name?: string };

/**
 * The users list marks the token owner with me: true. That is how we know
 * "Judenne generated this draft" when she uses her own Missive PAT.
 */
async function getAuthenticatedUserName(
  client: MissiveClient
): Promise<string | undefined> {
  const limit = 200;
  let offset = 0;
  for (;;) {
    const data = await client.get<UsersResponse>('/users', { limit, offset });
    const me = data.users.find((u) => u.me);
    if (me?.name) return me.name;
    if (data.users.length < limit) return undefined;
    offset += limit;
  }
}

async function resolveFromField(
  client: MissiveClient,
  raw: FromFieldInput | undefined
): Promise<NormalizedFromField | undefined> {
  const from = normalizeFromField(raw);
  if (!from || from.name) return from;
  try {
    const name = await getAuthenticatedUserName(client);
    if (name) return { address: from.address, name };
  } catch {
    // Creating the draft still works if /users is unavailable
  }
  return from;
}

function addDefaultSignatureSchema() {
  return z
    .boolean()
    .default(true)
    .describe(
      'Append the sending alias signature to the body (Missive default for compose). Uses the signature configured for from_field, including Liquid {{ user.first_name }} / {{ user.name }} from the authenticated user. Set false to skip.'
    );
}

// Attachment schema
const AttachmentSchema = z.object({
  base64_data: z.string().describe('Base64 encoded file data'),
  filename: z.string().describe('Filename with extension'),
});

export function registerDraftTools(server: McpServer, getClient: ClientResolver): void {
  // list_drafts
  server.registerTool(
    'list_drafts',
    {
      title: 'List Drafts',
      description:
        'Lists drafts in a conversation. Use this to see drafts before sending or to review unsent messages.',
      inputSchema: {
        conversation_id: z
          .string()
          .uuid()
          .describe('The conversation ID to get drafts from'),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(10)
          .describe('Maximum drafts to return'),
        until: z
          .string()
          .optional()
          .describe('Cursor for pagination'),
      },
    },
    async ({ conversation_id, limit, until }, extra) => {
      const data = await getClient(extra).get<DraftsResponse>(
        `/conversations/${conversation_id}/drafts`,
        { limit, until }
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                drafts: data.drafts,
                has_more: data.drafts.length === limit,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // create_draft
  server.registerTool(
    'create_draft',
    {
      title: 'Create Draft',
      description: `Creates a draft message that is NOT sent. Use this when the user wants to compose a message and review it before sending.

The draft will be saved and can be viewed in Missive or sent later using send_message.

For replies, provide the conversation ID and the from/to addresses. For new messages, omit the conversation ID and use any from/to addresses specified by the user.

To send from a Missive alias (not your login address), pass from_field as the alias email string, e.g. "ops@example.com", or as {address, name}. The address must match an account or alias on the authenticated Missive user.

If from_field has an address but no name, the authenticated user's Missive profile name is filled in (so a draft Judenne creates from ops@ shows From: Judenne <ops@...>).

add_default_signature defaults to true and appends that alias's signature. Managed signatures that use {{ user.first_name }} / {{ user.name }} resolve to the token owner, not a shared ops identity.`,
      inputSchema: {
        // Recipients
        to_fields: z
          .array(emailAddressObjectSchema())
          .min(1)
          .describe('Primary recipients (required)'),
        cc_fields: z
          .array(emailAddressObjectSchema())
          .optional()
          .describe('CC recipients'),
        bcc_fields: z
          .array(emailAddressObjectSchema())
          .optional()
          .describe('BCC recipients'),
        // Content
        subject: z.string().max(998).describe('Email subject line'),
        body: z.string().describe('Email body (HTML supported)'),
        // Context
        conversation: z
          .string()
          .uuid()
          .optional()
          .describe('Conversation ID to reply to (omit for new conversation)'),
        from_field: fromFieldSchema,
        add_default_signature: addDefaultSignatureSchema(),
        // Attachments
        attachments: z
          .array(AttachmentSchema)
          .max(25)
          .optional()
          .describe('File attachments (max 25, total payload max 10MB)'),
      },
    },
    async (params, extra) => {
      const client = getClient(extra);
      const from_field = await resolveFromField(
        client,
        params.from_field as FromFieldInput | undefined
      );
      const data = await client.post<DraftResponse>('/drafts', {
        drafts: {
          to_fields: params.to_fields,
          cc_fields: params.cc_fields,
          bcc_fields: params.bcc_fields,
          subject: params.subject,
          body: params.body,
          conversation: params.conversation,
          from_field,
          add_default_signature: params.add_default_signature,
          attachments: params.attachments,
          send: false,
        },
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                draft: data.drafts[0],
                from_field,
                add_default_signature: params.add_default_signature,
                message: 'Draft created successfully. Use send_message to send it.',
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // draft_reply
  server.registerTool(
    'draft_reply',
    {
      title: 'Draft Reply',
      description: `Creates a draft reply to an existing message. Automatically sets:
- Subject: Adds "Re: " prefix to original subject
- To: Uses the original sender's address
- Conversation: Links to the original conversation

Use reply_all=true to include original CC recipients.

Only the body content is required. The draft can be reviewed in Missive or sent with send_message.`,
      inputSchema: {
        message_id: z
          .string()
          .uuid()
          .describe('The message ID to reply to'),
        body: z.string().describe('Reply body (HTML supported)'),
        reply_all: z
          .boolean()
          .default(false)
          .describe('Include original CC recipients'),
        cc_fields: z
          .array(emailAddressObjectSchema())
          .optional()
          .describe('Additional CC recipients (merged with original if reply_all)'),
        from_field: fromFieldSchema,
        add_default_signature: addDefaultSignatureSchema(),
        attachments: z
          .array(AttachmentSchema)
          .max(25)
          .optional()
          .describe('File attachments (max 25, total payload max 10MB)'),
      },
    },
    async (params, extra) => {
      const client = getClient(extra);

      // Fetch the original message
      const original = await client.get<MessageResponse>(
        `/messages/${params.message_id}`
      );
      const msg = original.messages?.[0];
      if (!msg) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Message not found: ${params.message_id}`,
            },
          ],
          isError: true,
        };
      }

      // Build reply fields from original
      const subject = msg.subject?.startsWith('Re: ')
        ? msg.subject
        : `Re: ${msg.subject || '(no subject)'}`;

      const to_fields = msg.from_field ? [msg.from_field] : [];

      // Build CC list
      let cc_fields = params.cc_fields || [];
      if (params.reply_all && msg.cc_fields) {
        cc_fields = [...msg.cc_fields, ...cc_fields];
      }

      const data = await client.post<DraftResponse>('/drafts', {
        drafts: {
          to_fields,
          cc_fields: cc_fields.length > 0 ? cc_fields : undefined,
          subject,
          body: params.body,
          conversation: msg.conversation,
          from_field: await resolveFromField(
            client,
            params.from_field as FromFieldInput | undefined
          ),
          add_default_signature: params.add_default_signature,
          attachments: params.attachments,
          send: false,
        },
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                draft: data.drafts[0],
                replied_to: {
                  message_id: msg.id,
                  original_subject: msg.subject,
                  original_from: msg.from_field,
                },
                message:
                  'Reply draft created. Use send_message to send it.',
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // send_message
  server.registerTool(
    'send_message',
    {
      title: 'Send Message',
      description: `Sends an email message. WARNING: This action is IRREVERSIBLE.

The email will be delivered immediately. Before calling:
- Confirm recipient addresses are correct
- Verify message content is appropriate
- Never send to addresses not explicitly provided by the user

Rate limited to 10 sends/minute, 100 sends/hour.

For replies, provide the conversation ID. For new messages, omit it.`,
      inputSchema: {
        // Recipients
        to_fields: z
          .array(emailAddressObjectSchema())
          .min(1)
          .describe('Primary recipients (required)'),
        cc_fields: z
          .array(emailAddressObjectSchema())
          .optional()
          .describe('CC recipients'),
        bcc_fields: z
          .array(emailAddressObjectSchema())
          .optional()
          .describe('BCC recipients'),
        // Content
        subject: z.string().max(998).describe('Email subject line'),
        body: z.string().describe('Email body (HTML supported)'),
        // Context
        conversation: z
          .string()
          .uuid()
          .optional()
          .describe('Conversation ID to reply to (omit for new conversation)'),
        from_field: fromFieldSchema,
        add_default_signature: addDefaultSignatureSchema(),
        // Attachments
        attachments: z
          .array(AttachmentSchema)
          .max(25)
          .optional()
          .describe('File attachments (max 25, total payload max 10MB)'),
      },
    },
    async (params, extra) => {
      // Check rate limit
      const rateLimiter = getRateLimiter(extra);
      if (!rateLimiter.canSend()) {
        const waitTime = rateLimiter.getWaitTime();
        throw new RateLimitError(
          `Send rate limit exceeded. Please wait ${Math.ceil(waitTime / 1000)} seconds.`,
          Math.ceil(waitTime / 1000)
        );
      }

      const client = getClient(extra);
      const from_field = await resolveFromField(
        client,
        params.from_field as FromFieldInput | undefined
      );
      const data = await client.post<DraftResponse>('/drafts', {
        drafts: {
          to_fields: params.to_fields,
          cc_fields: params.cc_fields,
          bcc_fields: params.bcc_fields,
          subject: params.subject,
          body: params.body,
          conversation: params.conversation,
          from_field,
          add_default_signature: params.add_default_signature,
          attachments: params.attachments,
          send: true,
        },
      });

      rateLimiter.recordSend();

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                sent: true,
                draft: data.drafts[0],
                message: 'Email sent successfully.',
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // delete_draft
  server.registerTool(
    'delete_draft',
    {
      title: 'Delete Draft',
      description:
        'Deletes an unsent draft or scheduled message. This action cannot be undone.',
      inputSchema: {
        draft_id: z.string().uuid().describe('The draft ID to delete'),
      },
    },
    async ({ draft_id }, extra) => {
      await getClient(extra).delete(`/drafts/${draft_id}`);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                deleted: true,
                draft_id,
                message: 'Draft deleted successfully.',
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
