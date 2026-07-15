/**
 * Conversation tools: list and get conversations with search capabilities
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import type { ClientResolver } from '../types/tools.js';
import type {
  ConversationsResponse,
  ConversationResponse,
} from '../types/missive.js';
import { buildTeamInboxStats, resolveTeam } from '../conversation-stats.js';

export function registerConversationTools(server: McpServer, getClient: ClientResolver): void {
  // list_conversations
  server.registerTool(
    'list_conversations',
    {
      title: 'List Conversations',
      description: `Lists conversations visible to the authenticated user. Supports multiple filters and search by email/domain.

Common filter combinations:
- inbox=true: Shows inbox conversations
- assigned=true: Shows assigned conversations
- closed=true: Shows closed conversations
- email="user@example.com": Search by exact email address
- domain="example.com": Search by email domain

Note: email and domain are mutually exclusive.`,
      inputSchema: {
        // Filters
        inbox: z
          .boolean()
          .optional()
          .describe('Filter to inbox conversations'),
        all: z.boolean().optional().describe('Show all conversations'),
        assigned: z
          .boolean()
          .optional()
          .describe('Filter to assigned conversations'),
        closed: z
          .boolean()
          .optional()
          .describe('Filter to closed conversations'),
        snoozed: z
          .boolean()
          .optional()
          .describe('Filter to snoozed conversations'),
        flagged: z
          .boolean()
          .optional()
          .describe('Filter to flagged conversations'),
        trashed: z
          .boolean()
          .optional()
          .describe('Filter to trashed conversations'),
        junked: z
          .boolean()
          .optional()
          .describe('Filter to junked conversations'),
        drafts: z
          .boolean()
          .optional()
          .describe('Filter to conversations with drafts'),
        shared_label: z
          .string()
          .uuid()
          .optional()
          .describe('Filter by shared label ID'),
        team: z.string().uuid().optional().describe('Filter by team ID'),
        team_inbox: z.string().uuid().optional().describe('Filter by team inbox'),
        team_closed: z
          .string()
          .uuid()
          .optional()
          .describe('Filter by team closed'),
        team_all: z
          .string()
          .uuid()
          .optional()
          .describe('Filter by team (all conversations)'),
        organization: z
          .string()
          .uuid()
          .optional()
          .describe('Filter by organization ID'),
        // Search
        email: z
          .string()
          .email()
          .optional()
          .describe('Search by exact email address (mutually exclusive with domain)'),
        domain: z
          .string()
          .optional()
          .describe('Search by email domain (mutually exclusive with email)'),
        // Pagination
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(25)
          .describe('Maximum conversations to return (max 50)'),
        until: z
          .string()
          .optional()
          .describe('Cursor for pagination (last_activity_at timestamp)'),
      },
    },
    async (params, extra) => {
      // Validate mutually exclusive params
      if (params.email && params.domain) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: email and domain parameters are mutually exclusive',
            },
          ],
          isError: true,
        };
      }

      const data = await getClient(extra).get<ConversationsResponse>(
        '/conversations',
        {
          inbox: params.inbox,
          all: params.all,
          assigned: params.assigned,
          closed: params.closed,
          snoozed: params.snoozed,
          flagged: params.flagged,
          trashed: params.trashed,
          junked: params.junked,
          drafts: params.drafts,
          shared_label: params.shared_label,
          team: params.team,
          team_inbox: params.team_inbox,
          team_closed: params.team_closed,
          team_all: params.team_all,
          organization: params.organization,
          email: params.email,
          domain: params.domain,
          limit: params.limit,
          until: params.until,
        }
      );

      const result = {
        conversations: data.conversations,
        has_more: data.conversations.length === params.limit,
        next_cursor:
          data.conversations.length > 0
            ? String(
                data.conversations[data.conversations.length - 1].last_activity_at
              )
            : undefined,
      };

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

  // get_team_inbox_stats
  server.registerTool(
    'get_team_inbox_stats',
    {
      title: 'Get Team Inbox Stats',
      description: `Aggregates team inbox health for open/unassigned workload validation.

Returns:
- unassigned_inbox: full team_inbox queue (unassigned shared inbox)
- active_assigned: open workload by person using users[].assigned (not stale assignees[])
- hot_flags: open conversations with a shared label matching %hot% (case-insensitive)
- hot_flags.open_hot_snoozed: hot items where any user has snoozed=true
- exceptions: threshold-based flags (hot_open, hot_snoozed, unassigned_queue_high, stale_unassigned, active_workload_high)

Use team_name (partial match) or team_id. Paginates up to max_pages (50 convs/page).`,
      inputSchema: {
        team_id: z.string().uuid().optional().describe('Team UUID'),
        team_name: z
          .string()
          .optional()
          .describe('Team name partial match (e.g. "Maazah")'),
        organization_id: z
          .string()
          .uuid()
          .optional()
          .describe('Organization UUID for team lookup (defaults to first org)'),
        max_pages: z
          .number()
          .min(1)
          .max(40)
          .default(20)
          .describe('Max pages to fetch per view (50 conversations/page)'),
        unassigned_warning: z
          .number()
          .min(0)
          .default(10)
          .describe('Warn when unassigned inbox count exceeds this'),
        unassigned_critical: z
          .number()
          .min(0)
          .default(50)
          .describe('Critical when unassigned inbox count exceeds this'),
        stale_unassigned_hours: z
          .number()
          .min(1)
          .default(48)
          .describe('Flag unassigned queue items older than this many hours'),
        active_workload_warning: z
          .number()
          .min(1)
          .default(40)
          .describe('Warn when one person exceeds this many active assigned conversations'),
      },
    },
    async (params, extra) => {
      if (!params.team_id && !params.team_name) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: provide team_id or team_name',
            },
          ],
          isError: true,
        };
      }

      try {
        const client = getClient(extra);
        const team = await resolveTeam(client, {
          teamId: params.team_id,
          teamName: params.team_name,
          organizationId: params.organization_id,
        });
        const stats = await buildTeamInboxStats(client, team, params.max_pages, {
          unassigned_warning: params.unassigned_warning,
          unassigned_critical: params.unassigned_critical,
          stale_unassigned_hours: params.stale_unassigned_hours,
          active_workload_warning: params.active_workload_warning,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(stats, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: error instanceof Error ? error.message : 'Failed to get team inbox stats',
            },
          ],
          isError: true,
        };
      }
    }
  );

  // get_conversation
  server.registerTool(
    'get_conversation',
    {
      title: 'Get Conversation',
      description:
        'Gets a single conversation by ID. Returns conversation details including assignees, labels, and metadata.',
      inputSchema: {
        conversation_id: z
          .string()
          .uuid()
          .describe('The conversation ID to retrieve'),
      },
    },
    async ({ conversation_id }, extra) => {
      const data = await getClient(extra).get<ConversationResponse>(
        `/conversations/${conversation_id}`
      );

      const conversation = data.conversations?.[0];
      if (!conversation) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Conversation not found: ${conversation_id}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(conversation, null, 2),
          },
        ],
      };
    }
  );
}
