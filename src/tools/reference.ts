/**
 * Reference data tools: organizations, teams, users, contact books, shared labels
 * These tools include in-memory caching with TTL
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import type { ClientResolver } from '../types/tools.js';
import type {
  OrganizationsResponse,
  TeamsResponse,
  UsersResponse,
  ContactBooksResponse,
  SharedLabelsResponse,
} from '../types/missive.js';

// Simple TTL cache
interface CacheEntry<T> {
  data: T;
  expires: number;
}

class Cache {
  private store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry || Date.now() > entry.expires) {
      this.store.delete(key);
      return null;
    }
    return entry.data as T;
  }

  set<T>(key: string, data: T, ttlMs: number): void {
    this.store.set(key, { data, expires: Date.now() + ttlMs });
  }
}

const cache = new Cache();

// Cache TTLs
const TTL_1_HOUR = 60 * 60 * 1000;
const TTL_15_MIN = 15 * 60 * 1000;
const TTL_5_MIN = 5 * 60 * 1000;

function userPrefix(extra: { authInfo?: { extra?: Record<string, unknown> } }): string {
  return (extra.authInfo?.extra?.userId as string) || 'default';
}

export function registerReferenceTools(server: McpServer, getClient: ClientResolver): void {
  // list_organizations
  server.registerTool(
    'list_organizations',
    {
      title: 'List Organizations',
      description:
        'Lists all organizations the authenticated user belongs to. Organizations are the top-level entity in Missive.',
      inputSchema: {},
    },
    async (_params, extra) => {
      const prefix = userPrefix(extra);
      const cacheKey = `${prefix}:organizations`;
      let data = cache.get<OrganizationsResponse>(cacheKey);

      if (!data) {
        data = await getClient(extra).get<OrganizationsResponse>('/organizations');
        cache.set(cacheKey, data, TTL_1_HOUR);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(data.organizations, null, 2),
          },
        ],
      };
    }
  );

  // list_teams
  server.registerTool(
    'list_teams',
    {
      title: 'List Teams',
      description:
        'Lists all teams the authenticated user has access to. Filter by organization if needed.',
      inputSchema: {
        organization: z
          .string()
          .uuid()
          .optional()
          .describe('Filter by organization ID'),
        limit: z
          .number()
          .min(1)
          .max(200)
          .default(50)
          .describe('Maximum number of teams to return'),
        offset: z.number().min(0).default(0).describe('Offset for pagination'),
      },
    },
    async ({ organization, limit, offset }, extra) => {
      const prefix = userPrefix(extra);
      const cacheKey = `${prefix}:teams:${organization ?? 'all'}:${limit}:${offset}`;
      let data = cache.get<TeamsResponse>(cacheKey);

      if (!data) {
        data = await getClient(extra).get<TeamsResponse>('/teams', {
          organization,
          limit,
          offset,
        });
        cache.set(cacheKey, data, TTL_15_MIN);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(data.teams, null, 2),
          },
        ],
      };
    }
  );

  // list_users
  server.registerTool(
    'list_users',
    {
      title: 'List Users',
      description:
        'Lists users in organizations the authenticated user belongs to. The token owner has me: true. Use this to find user IDs for assignments.',
      inputSchema: {
        organization: z
          .string()
          .uuid()
          .optional()
          .describe('Filter by organization ID'),
        limit: z
          .number()
          .min(1)
          .max(200)
          .default(50)
          .describe('Maximum number of users to return'),
        offset: z.number().min(0).default(0).describe('Offset for pagination'),
      },
    },
    async ({ organization, limit, offset }, extra) => {
      const prefix = userPrefix(extra);
      const cacheKey = `${prefix}:users:${organization ?? 'all'}:${limit}:${offset}`;
      let data = cache.get<UsersResponse>(cacheKey);

      if (!data) {
        data = await getClient(extra).get<UsersResponse>('/users', {
          organization,
          limit,
          offset,
        });
        cache.set(cacheKey, data, TTL_15_MIN);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(data.users, null, 2),
          },
        ],
      };
    }
  );

  // list_contact_books
  server.registerTool(
    'list_contact_books',
    {
      title: 'List Contact Books',
      description:
        'Lists all contact books the authenticated user has access to. Required before creating contacts.',
      inputSchema: {
        limit: z
          .number()
          .min(1)
          .max(200)
          .default(50)
          .describe('Maximum number of contact books to return'),
        offset: z.number().min(0).default(0).describe('Offset for pagination'),
      },
    },
    async ({ limit, offset }, extra) => {
      const prefix = userPrefix(extra);
      const cacheKey = `${prefix}:contact_books:${limit}:${offset}`;
      let data = cache.get<ContactBooksResponse>(cacheKey);

      if (!data) {
        data = await getClient(extra).get<ContactBooksResponse>('/contact_books', {
          limit,
          offset,
        });
        cache.set(cacheKey, data, TTL_15_MIN);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(data.contact_books, null, 2),
          },
        ],
      };
    }
  );

  // list_shared_labels
  server.registerTool(
    'list_shared_labels',
    {
      title: 'List Shared Labels',
      description:
        'Lists all shared labels available for tagging conversations. Use label IDs to filter conversations or apply labels.',
      inputSchema: {
        organization: z
          .string()
          .uuid()
          .optional()
          .describe('Filter by organization ID'),
        limit: z
          .number()
          .min(1)
          .max(200)
          .default(50)
          .describe('Maximum number of labels to return'),
        offset: z.number().min(0).default(0).describe('Offset for pagination'),
      },
    },
    async ({ organization, limit, offset }, extra) => {
      const prefix = userPrefix(extra);
      const cacheKey = `${prefix}:shared_labels:${organization ?? 'all'}:${limit}:${offset}`;
      let data = cache.get<SharedLabelsResponse>(cacheKey);

      if (!data) {
        data = await getClient(extra).get<SharedLabelsResponse>('/shared_labels', {
          organization,
          limit,
          offset,
        });
        cache.set(cacheKey, data, TTL_5_MIN);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(data.shared_labels, null, 2),
          },
        ],
      };
    }
  );
}
