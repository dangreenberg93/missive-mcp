import type { Message, MessageResponse } from './types/missive.js';
import type { MissiveClient } from './client.js';
import { NotFoundError } from './errors.js';

export function normalizeMessagesResponse(
  data: MessageResponse | { messages: Message | Message[] }
): Message[] {
  const { messages } = data;
  if (!messages) return [];
  return Array.isArray(messages) ? messages : [messages];
}

export async function findMessageInConversation(
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

export async function fetchMessageById(
  client: MissiveClient,
  messageId: string,
  conversationId?: string
): Promise<Message | undefined> {
  try {
    const data = await client.get<MessageResponse | { messages: Message | Message[] }>(
      `/messages/${messageId}`
    );
    return normalizeMessagesResponse(data)[0];
  } catch (error) {
    if (error instanceof NotFoundError && conversationId) {
      return findMessageInConversation(client, conversationId, messageId);
    }
    throw error;
  }
}
