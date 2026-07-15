/**
 * Attachment tools: list and download message attachments
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import type { ClientResolver } from '../types/tools.js';
import { fetchMessageById } from '../message-fetch.js';
import {
  attachmentContentType,
  summarizeAttachment,
} from '../attachment-utils.js';

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function registerAttachmentTools(
  server: McpServer,
  getClient: ClientResolver
): void {
  server.registerTool(
    'list_message_attachments',
    {
      title: 'List Message Attachments',
      description: `Lists file attachments on a Missive message (metadata only — no file bytes).

Use download_attachment to fetch file content as base64 for Voyager upload or analysis.

Signed download URLs come from GET /messages/{id}. For outbound messages that 404, pass conversation_id.`,
      inputSchema: {
        message_id: z.string().uuid().describe('The message ID'),
        conversation_id: z
          .string()
          .uuid()
          .optional()
          .describe('Conversation ID fallback when GET /messages/{id} returns 404'),
      },
    },
    async ({ message_id, conversation_id }, extra) => {
      const client = getClient(extra);
      const message = await fetchMessageById(client, message_id, conversation_id);

      if (!message) {
        return {
          content: [
            {
              type: 'text' as const,
              text: conversation_id
                ? `Message not found: ${message_id} (also checked conversation ${conversation_id})`
                : `Message not found: ${message_id}. Pass conversation_id for outbound fallback.`,
            },
          ],
          isError: true,
        };
      }

      const attachments = message.attachments ?? [];

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                message_id: message.id,
                subject: message.subject,
                attachment_count: attachments.length,
                attachments: attachments.map(summarizeAttachment),
                note:
                  attachments.length > 0
                    ? 'Use download_attachment with message_id and attachment_id to fetch file_base64.'
                    : undefined,
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
    'download_attachment',
    {
      title: 'Download Attachment',
      description: `Downloads a Missive message attachment and returns base64-encoded bytes.

Use with Voyager MCP voyager_attach_order_document (pass file_base64, file_name, content_type).

Missive signed URLs require API Bearer auth — this tool handles that. URLs expire; always download fresh via message_id + attachment_id.

Max file size defaults to 25 MB (matches Voyager attach limit).`,
      inputSchema: {
        message_id: z.string().uuid().describe('The message ID'),
        attachment_id: z.string().uuid().describe('Attachment UUID from list_message_attachments'),
        conversation_id: z
          .string()
          .uuid()
          .optional()
          .describe('Conversation ID fallback when GET /messages/{id} returns 404'),
        max_bytes: z
          .number()
          .int()
          .min(1)
          .max(DEFAULT_MAX_BYTES)
          .default(DEFAULT_MAX_BYTES)
          .describe('Maximum download size in bytes (default 25 MB)'),
      },
    },
    async ({ message_id, attachment_id, conversation_id, max_bytes }, extra) => {
      const client = getClient(extra);
      const message = await fetchMessageById(client, message_id, conversation_id);

      if (!message) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Message not found: ${message_id}`,
            },
          ],
          isError: true,
        };
      }

      const attachment = message.attachments?.find((a) => a.id === attachment_id);
      if (!attachment) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  error: `Attachment not found: ${attachment_id}`,
                  message_id,
                  available_attachment_ids: (message.attachments ?? []).map((a) => a.id),
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      if (!attachment.url) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Attachment ${attachment_id} has no download URL. Re-fetch message via GET /messages/{id}.`,
            },
          ],
          isError: true,
        };
      }

      const bytes = await client.downloadSignedUrl(attachment.url, max_bytes);
      const contentType = attachmentContentType(attachment);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                message_id: message.id,
                attachment: summarizeAttachment(attachment),
                content_type: contentType,
                size_bytes: bytes.byteLength,
                file_base64: bytesToBase64(bytes),
                voyager_handoff: {
                  tool: 'voyager_attach_order_document',
                  file_name: attachment.filename,
                  file_base64: '<use file_base64 above>',
                  content_type: contentType,
                },
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
