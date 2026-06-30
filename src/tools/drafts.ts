/**
 * Draft tools: list, create, reply, and delete drafts.
 * Send is intentionally disabled — drafts only.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import type { ClientResolver } from '../types/tools.js';
import type {
  ConversationResponse,
  DraftResponse,
  DraftsResponse,
  EmailAddress,
  Message,
} from '../types/missive.js';
import type { MissiveClient } from '../client.js';

const EmailFieldSchema = z.object({
  address: z.string().email().describe('Email address'),
  name: z.string().optional().describe('Display name'),
});

const AttachmentSchema = z.object({
  base64_data: z.string().describe('Base64 encoded file data'),
  filename: z.string().describe('Filename with extension'),
});

function resolveQuotePreviousMessage(
  quotePreviousMessage: boolean | undefined,
  conversation: string | undefined
): boolean | undefined {
  if (quotePreviousMessage !== undefined) {
    return quotePreviousMessage;
  }
  return conversation ? true : undefined;
}

function replySubject(subject: string | undefined): string {
  const base = subject || '(no subject)';
  return base.startsWith('Re: ') ? base : `Re: ${base}`;
}

async function getReplyContext(
  client: MissiveClient,
  conversationId: string,
  replyAll: boolean
): Promise<{
  subject: string;
  to_fields: EmailAddress[];
  cc_fields?: EmailAddress[];
  replied_to_message_id: string;
}> {
  const [messagesResponse, conversationResponse] = await Promise.all([
    client.get<{ messages: Message[] }>(`/conversations/${conversationId}/messages`, {
      limit: 10,
    }),
    client.get<ConversationResponse>(`/conversations/${conversationId}`),
  ]);

  const messages = messagesResponse.messages;
  if (messages.length === 0) {
    throw new Error(`No messages found in conversation ${conversationId}`);
  }

  const conversation = conversationResponse.conversations?.[0];
  const inbound = messages.find((message) => !message.author);
  const reference = inbound ?? messages[0];

  let to_fields: EmailAddress[] = [];
  if (inbound?.from_field) {
    to_fields = [inbound.from_field];
  } else if (reference.to_fields?.length) {
    to_fields = reference.to_fields;
  }

  if (to_fields.length === 0) {
    throw new Error(
      `Could not determine reply recipients for conversation ${conversationId}`
    );
  }

  let cc_fields: EmailAddress[] | undefined;
  if (replyAll) {
    const merged = [...(inbound?.cc_fields ?? reference.cc_fields ?? [])];
    cc_fields = merged.length > 0 ? merged : undefined;
  }

  const subject = replySubject(
    reference.subject ??
      conversation?.latest_message_subject ??
      conversation?.subject
  );

  return {
    subject,
    to_fields,
    cc_fields,
    replied_to_message_id: reference.id,
  };
}

function buildDraftPayload(params: {
  to_fields: EmailAddress[];
  cc_fields?: EmailAddress[];
  bcc_fields?: EmailAddress[];
  subject: string;
  body: string;
  conversation?: string;
  from_field?: EmailAddress;
  attachments?: z.infer<typeof AttachmentSchema>[];
  quote_previous_message?: boolean;
}): Record<string, unknown> {
  return {
    to_fields: params.to_fields,
    cc_fields: params.cc_fields,
    bcc_fields: params.bcc_fields,
    subject: params.subject,
    body: params.body,
    conversation: params.conversation,
    from_field: params.from_field,
    attachments: params.attachments,
    quote_previous_message: resolveQuotePreviousMessage(
      params.quote_previous_message,
      params.conversation
    ),
    send: false,
  };
}

export function registerDraftTools(server: McpServer, getClient: ClientResolver): void {
  server.registerTool(
    'list_drafts',
    {
      title: 'List Drafts',
      description:
        'Lists drafts in a conversation. Use this to review unsent messages before a human sends from Missive.',
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
        until: z.string().optional().describe('Cursor for pagination'),
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

  server.registerTool(
    'reply_to_conversation',
    {
      title: 'Reply to Conversation',
      description: `Creates a draft reply in an existing conversation. This is the preferred tool for thread replies.

Automatically sets:
- Recipients from the latest inbound message (or thread recipients if latest is outbound)
- Subject with Re: prefix
- quote_previous_message (defaults to true)

The draft is NOT sent. A human must review and send from Missive.

HTML formatting: Use <br><br> between paragraphs.`,
      inputSchema: {
        conversation_id: z
          .string()
          .uuid()
          .describe('The conversation ID to reply in'),
        body: z.string().describe('Reply body (HTML supported)'),
        reply_all: z
          .boolean()
          .default(false)
          .describe('Include CC recipients from the message being replied to'),
        cc_fields: z
          .array(EmailFieldSchema)
          .optional()
          .describe('Additional CC recipients'),
        from_field: EmailFieldSchema.optional().describe(
          'Override sender (uses default if omitted)'
        ),
        attachments: z
          .array(AttachmentSchema)
          .max(25)
          .optional()
          .describe('File attachments (max 25, total payload max 10MB)'),
        quote_previous_message: z
          .boolean()
          .default(true)
          .describe('Include a quoted version of the previous message'),
      },
    },
    async (params, extra) => {
      const client = getClient(extra);
      const context = await getReplyContext(
        client,
        params.conversation_id,
        params.reply_all
      );

      let cc_fields = params.cc_fields ?? context.cc_fields;
      if (params.cc_fields && context.cc_fields) {
        cc_fields = [...context.cc_fields, ...params.cc_fields];
      }

      const data = await client.post<DraftResponse>('/drafts', {
        drafts: buildDraftPayload({
          to_fields: context.to_fields,
          cc_fields,
          subject: context.subject,
          body: params.body,
          conversation: params.conversation_id,
          from_field: params.from_field,
          attachments: params.attachments,
          quote_previous_message: params.quote_previous_message,
        }),
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                draft: data.drafts[0],
                reply: {
                  conversation_id: params.conversation_id,
                  replied_to_message_id: context.replied_to_message_id,
                  to_fields: context.to_fields,
                  subject: context.subject,
                  quote_previous_message: params.quote_previous_message,
                },
                message:
                  'Reply draft created. Review and send from the Missive app.',
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    'create_draft',
    {
      title: 'Create Draft',
      description: `Creates a draft for a NEW outbound message (not a thread reply). Use reply_to_conversation for replies.

The draft is NOT sent. A human must review and send from Missive.

HTML formatting: Use <br><br> between paragraphs. Do not wrap content in <p>, <div>, or style blocks.`,
      inputSchema: {
        to_fields: z
          .array(EmailFieldSchema)
          .min(1)
          .describe('Primary recipients (required)'),
        cc_fields: z.array(EmailFieldSchema).optional().describe('CC recipients'),
        bcc_fields: z.array(EmailFieldSchema).optional().describe('BCC recipients'),
        subject: z.string().max(998).describe('Email subject line'),
        body: z.string().describe('Email body (HTML supported)'),
        from_field: EmailFieldSchema.optional().describe(
          'Sender address (uses default if omitted)'
        ),
        attachments: z
          .array(AttachmentSchema)
          .max(25)
          .optional()
          .describe('File attachments (max 25, total payload max 10MB)'),
      },
    },
    async (params, extra) => {
      const data = await getClient(extra).post<DraftResponse>('/drafts', {
        drafts: buildDraftPayload(params),
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                draft: data.drafts[0],
                message:
                  'Draft created. Review and send from the Missive app.',
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    'delete_draft',
    {
      title: 'Delete Draft',
      description:
        'Deletes an unsent draft. This action cannot be undone.',
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
