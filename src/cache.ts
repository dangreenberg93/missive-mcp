/**
 * Timeline cache for efficient incremental fetching
 *
 * Caches conversation timeline items (messages, posts, comments) with
 * timestamp tracking to enable:
 * - Stopping fetches early when we hit cached items
 * - Continuing pagination from where we left off
 */

import type { Message, Post, Comment } from './types/missive.js';

export interface CachedType<T> {
  items: Map<string, T>;
  oldestTimestamp: number;
  newestTimestamp: number;
}

interface ConversationCache {
  messages: CachedType<Message>;
  posts: CachedType<Post>;
  comments: CachedType<Comment>;
}

function createEmptyCachedType<T>(): CachedType<T> {
  return {
    items: new Map(),
    oldestTimestamp: Infinity,
    newestTimestamp: 0,
  };
}

const cache = new Map<string, ConversationCache>();

export function getCache(conversationId: string): ConversationCache {
  let conv = cache.get(conversationId);
  if (!conv) {
    conv = {
      messages: createEmptyCachedType(),
      posts: createEmptyCachedType(),
      comments: createEmptyCachedType(),
    };
    cache.set(conversationId, conv);
  }
  return conv;
}

/**
 * Add items to cache and update timestamp bounds
 * Returns true if any items were new (not already cached)
 */
export function addToCache<T extends { id: string }>(
  cached: CachedType<T>,
  items: T[],
  getTimestamp: (item: T) => number
): { newItems: T[]; hitCache: boolean } {
  const newItems: T[] = [];
  let hitCache = false;

  for (const item of items) {
    if (cached.items.has(item.id)) {
      hitCache = true;
      continue;
    }

    cached.items.set(item.id, item);
    newItems.push(item);

    const ts = getTimestamp(item);
    if (ts < cached.oldestTimestamp) cached.oldestTimestamp = ts;
    if (ts > cached.newestTimestamp) cached.newestTimestamp = ts;
  }

  return { newItems, hitCache };
}

/**
 * Get all cached items within a time range, sorted by timestamp
 */
export function getCachedItems<T>(
  cached: CachedType<T>,
  getTimestamp: (item: T) => number,
  fromTime?: number,
  toTime?: number
): T[] {
  const items = Array.from(cached.items.values());

  return items
    .filter((item) => {
      const ts = getTimestamp(item);
      if (fromTime !== undefined && ts < fromTime) return false;
      if (toTime !== undefined && ts > toTime) return false;
      return true;
    })
    .sort((a, b) => getTimestamp(a) - getTimestamp(b));
}

/**
 * Check if we have cached items and get the timestamp bounds
 */
export function getCacheBounds(cached: CachedType<unknown>): {
  hasItems: boolean;
  oldest: number;
  newest: number;
} {
  const hasItems = cached.items.size > 0;
  return {
    hasItems,
    oldest: hasItems ? cached.oldestTimestamp : Infinity,
    newest: hasItems ? cached.newestTimestamp : 0,
  };
}

/**
 * Clear cache for a conversation (useful for testing or forced refresh)
 */
export function clearCache(conversationId: string): void {
  cache.delete(conversationId);
}

/**
 * Clear only cached messages for a conversation (forces re-fetch from Missive)
 */
export function clearMessageCache(conversationId: string): void {
  const conv = cache.get(conversationId);
  if (conv) {
    conv.messages = createEmptyCachedType();
  }
}

/**
 * Get cache stats for debugging
 */
export function getCacheStats(conversationId: string): {
  messages: number;
  posts: number;
  comments: number;
} | null {
  const conv = cache.get(conversationId);
  if (!conv) return null;
  return {
    messages: conv.messages.items.size,
    posts: conv.posts.items.size,
    comments: conv.comments.items.size,
  };
}
