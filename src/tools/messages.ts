/**
 * Message tools: list and get messages with body truncation options
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import type { ClientResolver } from '../types/tools.js';
import type {
  MessageResponse,
  TimelineItem,
  Message,
  Post,
  Comment,
} from '../types/missive.js';
import {
  getCache,
  addToCache,
  getCachedItems,
  getCacheBounds,
  getCacheStats,
  clearMessageCache,
} from '../cache.js';
import { NotFoundError } from '../errors.js';
import type { MissiveClient } from '../client.js';

/**
 * Strip HTML tags and normalize whitespace
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Process message body based on format options
 */
function processBody(
  body: string | undefined,
  format: 'full' | 'truncated' | 'preview',
  stripHtmlFlag: boolean,
  maxLength: number
): string {
  if (!body) return '';

  let processed = stripHtmlFlag ? stripHtml(body) : body;

  if (format === 'preview') {
    return processed.substring(0, 500) + (processed.length > 500 ? '...' : '');
  }

  if (format === 'truncated' && processed.length > maxLength) {
    return (
      processed.substring(0, maxLength) +
      `\n\n[... truncated, ${processed.length - maxLength} more characters]`
    );
  }

  return processed;
}

function normalizeMessagesResponse(
  data: MessageResponse | { messages: Message | Message[] }
): Message[] {
  const { messages } = data;
  if (!messages) return [];
  return Array.isArray(messages) ? messages : [messages];
}

async function findMessageInConversation(
  client: MissiveClient,
  conversationId: string,
  messageId: string
): Promise<Message | undefined> {
  let cursor: string | undefined;

  while (true) {
    const params: { limit: number; until?: string } = { limit: 10 };
    if (cursor) params.until = cursor;

    const response = await client.get<{ messages: Message[] }>(
      `/conversations/${conversationId}/messages`,
      params
    );

    if (response.messages.length === 0) break;

    const match = response.messages.find((m) => m.id === messageId);
    if (match) return match;

    if (response.messages.length < 10) break;

    const last = response.messages[response.messages.length - 1];
    cursor = String(last.delivered_at || 0);
  }

  return undefined;
}

async function hydrateMessageBodies(
  client: MissiveClient,
  messages: Message[]
): Promise<Map<string, string>> {
  const bodies = new Map<string, string>();
  const ids = messages.map((m) => m.id);

  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);

    try {
      const data = await client.get<MessageResponse | { messages: Message | Message[] }>(
        `/messages/${batch.join(',')}`
      );
      for (const message of normalizeMessagesResponse(data)) {
        if (message.body) {
          bodies.set(message.id, message.body);
        }
      }
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        throw error;
      }

      // Batch may fail if any ID is missing; try individually
      for (const id of batch) {
        try {
          const data = await client.get<MessageResponse | { messages: Message | Message[] }>(
            `/messages/${id}`
          );
          const message = normalizeMessagesResponse(data)[0];
          if (message?.body) {
            bodies.set(message.id, message.body);
          }
        } catch (individualError) {
          if (!(individualError instanceof NotFoundError)) {
            throw individualError;
          }
        }
      }
    }
  }

  return bodies;
}

function formatMessageResult(
  message: Message,
  body_format: 'full' | 'truncated' | 'preview',
  strip_html: boolean,
  max_body_length: number,
  source: 'message' | 'timeline' = 'message'
) {
  const rawBody = message.body || message.preview;
  const processedBody = processBody(
    rawBody,
    body_format,
    strip_html,
    max_body_length
  );

  return {
    id: message.id,
    subject: message.subject,
    body: processedBody,
    from_field: message.from_field,
    to_fields: message.to_fields,
    cc_fields: message.cc_fields,
    delivered_at: message.delivered_at,
    attachments: message.attachments?.map((a) => ({
      id: a.id,
      filename: a.filename,
      size: a.size,
      content_type: a.content_type,
    })),
    conversation: message.conversation,
    ...(source === 'timeline' && !message.body
      ? { note: 'Full body unavailable via GET /messages; returned preview from conversation timeline' }
      : {}),
  };
}

function userPrefix(extra: { authInfo?: { extra?: Record<string, unknown> } }): string {
  return (extra.authInfo?.extra?.userId as string) || 'default';
}

export function registerMessageTools(server: McpServer, getClient: ClientResolver): void {
  // get_message
  server.registerTool(
    'get_message',
    {
      title: 'Get Message',
      description: `Gets a single message by ID with full body content. Supports body processing options to manage size.

Body format options:
- full: Returns complete body (may be large for HTML emails)
- truncated: Truncates body to max_body_length (default)
- preview: Returns first 500 characters only

Use strip_html=true (default) to convert HTML to plain text.

For outbound messages sent via the API, GET /messages/{id} may return 404. Pass conversation_id to fall back to the conversation timeline entry (preview only for outbound).`,
      inputSchema: {
        message_id: z.string().uuid().describe('The message ID to retrieve'),
        conversation_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Conversation ID (required fallback for outbound messages that 404 on GET /messages/{id})'
          ),
        body_format: z
          .enum(['full', 'truncated', 'preview'])
          .default('truncated')
          .describe('How to process the message body'),
        strip_html: z
          .boolean()
          .default(true)
          .describe('Convert HTML body to plain text'),
        max_body_length: z
          .number()
          .min(100)
          .max(50000)
          .default(5000)
          .describe('Maximum body length for truncated format'),
      },
    },
    async ({ message_id, conversation_id, body_format, strip_html, max_body_length }, extra) => {
      const client = getClient(extra);
      let message: Message | undefined;

      try {
        const data = await client.get<MessageResponse | { messages: Message | Message[] }>(
          `/messages/${message_id}`
        );
        message = normalizeMessagesResponse(data)[0];
      } catch (error) {
        if (error instanceof NotFoundError && conversation_id) {
          message = await findMessageInConversation(client, conversation_id, message_id);
        } else {
          throw error;
        }
      }

      if (!message) {
        return {
          content: [
            {
              type: 'text' as const,
              text: conversation_id
                ? `Message not found: ${message_id} (also checked conversation ${conversation_id})`
                : `Message not found: ${message_id}. Pass conversation_id for outbound message fallback.`,
            },
          ],
          isError: true,
        };
      }

      const source = message.body ? 'message' : 'timeline';
      const result = formatMessageResult(
        message,
        body_format,
        strip_html,
        max_body_length,
        source
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // get_conversation_timeline
  server.registerTool(
    'get_conversation_timeline',
    {
      title: 'Get Conversation Timeline',
      description: `Returns all messages, posts, and comments in a conversation as a unified chronological timeline.

This matches how Missive displays conversations - emails, internal notes, state changes, and team comments interleaved by time.

Each item has a "type" field ("message", "post", or "comment") to identify what it is.

Uses smart caching: stops fetching when hitting cached data.

When body_format is "truncated", full message bodies are fetched via GET /messages/{id} because the conversation messages list only includes short previews (~140 chars).

To paginate backwards: pass older_than with the oldest_timestamp from the previous response.

Use get_message with message_id and conversation_id if you need a single message outside the timeline.`,
      inputSchema: {
        conversation_id: z
          .string()
          .uuid()
          .describe('The conversation ID'),
        page_size: z
          .number()
          .min(10)
          .max(100)
          .default(30)
          .describe('Maximum total items to return'),
        older_than: z
          .number()
          .optional()
          .describe('Fetch items older than this timestamp (for pagination)'),
        body_format: z
          .enum(['preview', 'truncated'])
          .default('preview')
          .describe('How to process message bodies (preview=500 chars, truncated=max_body_length)'),
        strip_html: z
          .boolean()
          .default(true)
          .describe('Convert HTML body to plain text'),
        max_body_length: z
          .number()
          .min(100)
          .max(10000)
          .default(2000)
          .describe('Maximum body length for truncated format'),
      },
    },
    async ({
      conversation_id,
      page_size,
      older_than,
      body_format,
      strip_html,
      max_body_length,
    }, extra) => {
      const prefix = userPrefix(extra);
      const cacheKey = `${prefix}:${conversation_id}`;
      const cache = getCache(cacheKey);
      const client = getClient(extra);

      let fetchedMessages = 0;
      let fetchedPosts = 0;
      let fetchedComments = 0;

      // Fetch messages with cache-aware stopping
      async function fetchMessages(until?: string): Promise<number> {
        let cursor = until;
        let fetched = 0;

        while (fetched < page_size) {
          const params: { limit: number; until?: string } = { limit: 10 };
          if (cursor) params.until = cursor;

          const response = await client.get<{ messages: Message[] }>(
            `/conversations/${conversation_id}/messages`,
            params
          );

          if (response.messages.length === 0) break;

          const result = addToCache(
            cache.messages,
            response.messages,
            (m) => m.delivered_at || 0
          );
          fetched += result.newItems.length;

          if (result.hitCache || response.messages.length < 10) break;

          const last = response.messages[response.messages.length - 1];
          cursor = String(last.delivered_at || 0);
        }

        return fetched;
      }

      // Fetch posts with cache-aware stopping
      async function fetchPosts(until?: string): Promise<number> {
        let cursor = until;
        let fetched = 0;

        while (fetched < page_size) {
          const params: { limit: number; until?: string } = { limit: 10 };
          if (cursor) params.until = cursor;

          const response = await client.get<{ posts: Post[] }>(
            `/conversations/${conversation_id}/posts`,
            params
          );

          if (response.posts.length === 0) break;

          const result = addToCache(cache.posts, response.posts, (p) => p.created_at);
          fetched += result.newItems.length;

          if (result.hitCache || response.posts.length < 10) break;

          const last = response.posts[response.posts.length - 1];
          cursor = String(last.created_at);
        }

        return fetched;
      }

      // Fetch comments with cache-aware stopping
      async function fetchComments(until?: string): Promise<number> {
        let cursor = until;
        let fetched = 0;

        while (fetched < page_size) {
          const params: { limit: number; until?: string } = { limit: 10 };
          if (cursor) params.until = cursor;

          const response = await client.get<{ comments: Comment[] }>(
            `/conversations/${conversation_id}/comments`,
            params
          );

          if (response.comments.length === 0) break;

          const result = addToCache(
            cache.comments,
            response.comments,
            (c) => c.created_at
          );
          fetched += result.newItems.length;

          if (result.hitCache || response.comments.length < 10) break;

          const last = response.comments[response.comments.length - 1];
          cursor = String(last.created_at);
        }

        return fetched;
      }

      // Fetch all types in parallel
      // If older_than provided, use it as starting cursor
      const startCursor = older_than ? String(older_than) : undefined;
      const [msgCount, postCount, commentCount] = await Promise.all([
        fetchMessages(startCursor),
        fetchPosts(startCursor),
        fetchComments(startCursor),
      ]);
      fetchedMessages = msgCount;
      fetchedPosts = postCount;
      fetchedComments = commentCount;

      const statsBeforeHydration = getCacheStats(cacheKey);
      if (
        body_format === 'truncated' &&
        fetchedMessages === 0 &&
        statsBeforeHydration &&
        statsBeforeHydration.messages > 0
      ) {
        clearMessageCache(cacheKey);
        fetchedMessages = await fetchMessages(startCursor);
      }

      // Build timeline from cache
      const updatedMsgBounds = getCacheBounds(cache.messages);
      const messages = getCachedItems(
        cache.messages,
        (m: Message) => m.delivered_at || 0
      );
      const posts = getCachedItems(cache.posts, (p: Post) => p.created_at);
      const comments = getCachedItems(
        cache.comments,
        (c: Comment) => c.created_at
      );

      let hydratedBodies: Map<string, string> | undefined;
      if (body_format === 'truncated' && messages.length > 0) {
        hydratedBodies = await hydrateMessageBodies(client, messages);
      }

      // Determine time window for timeline (based on messages)
      const oldestMessageTime = updatedMsgBounds.hasItems ? updatedMsgBounds.oldest : 0;

      // Convert to timeline items, filtering posts/comments to message time window
      const timeline: TimelineItem[] = [];

      for (const m of messages) {
        const rawBody = hydratedBodies?.get(m.id) || m.body || m.preview;
        const processedBody = processBody(
          rawBody,
          body_format,
          strip_html,
          max_body_length
        );
        timeline.push({
          type: 'message',
          timestamp: m.delivered_at || 0,
          data: {
            id: m.id,
            subject: m.subject,
            body: processedBody,
            from_field: m.from_field,
            to_fields: m.to_fields,
            delivered_at: m.delivered_at,
            attachments: m.attachments?.map((a) => ({
              id: a.id,
              filename: a.filename,
              size: a.size,
              content_type: a.content_type,
            })),
          },
        });
      }

      for (const p of posts) {
        if (p.created_at >= oldestMessageTime) {
          timeline.push({
            type: 'post',
            timestamp: p.created_at,
            data: {
              id: p.id,
              text: p.text,
              author: p.author,
              created_at: p.created_at,
              notification: p.notification,
              attachments: p.attachments?.map((a) => ({
                id: a.id,
                filename: a.filename,
                size: a.size,
                content_type: a.content_type,
              })),
            },
          });
        }
      }

      for (const c of comments) {
        if (c.created_at >= oldestMessageTime) {
          timeline.push({
            type: 'comment',
            timestamp: c.created_at,
            data: {
              id: c.id,
              body: c.body,
              author: c.author,
              created_at: c.created_at,
              mentions: c.mentions,
              task: c.task,
              attachments: c.attachments?.map((a) => ({
                id: a.id,
                filename: a.filename,
                size: a.size,
                content_type: a.content_type,
              })),
            },
          });
        }
      }

      // Sort by timestamp, oldest first (chronological reading order)
      timeline.sort((a, b) => a.timestamp - b.timestamp);

      // Truncate to page_size (keep most recent)
      const truncated = timeline.length > page_size;
      const finalTimeline = truncated ? timeline.slice(-page_size) : timeline;

      // Find oldest timestamp for pagination
      const oldestTimestamp =
        finalTimeline.length > 0 ? finalTimeline[0].timestamp : null;

      const stats = getCacheStats(cacheKey);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                timeline: finalTimeline,
                oldest_timestamp: oldestTimestamp,
                counts: {
                  total: finalTimeline.length,
                  truncated,
                },
                fetched: {
                  messages: fetchedMessages,
                  posts: fetchedPosts,
                  comments: fetchedComments,
                },
                cached: stats,
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
