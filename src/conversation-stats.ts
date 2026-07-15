/**
 * Helpers for aggregating team inbox stats from conversation list responses.
 */

import type { MissiveClient } from './client.js';
import type { Conversation, ConversationsResponse, Team, TeamsResponse } from './types/missive.js';

export const HOT_LABEL_PATTERN = /hot/i;

export interface UnassignedQueueItem {
  id: string;
  subject: string;
  labels: string[];
  attachments: number;
  messages: number;
  last_activity_at: number;
  has_draft: boolean;
}

export interface HotFlagItem {
  id: string;
  subject: string;
  hot_labels: string[];
  assignees: string;
  snoozed_by: string[];
  last_activity_at: number;
}

export type ExceptionSeverity = 'critical' | 'warning' | 'info';

export type InboxExceptionType =
  | 'hot_open'
  | 'hot_snoozed'
  | 'unassigned_queue_high'
  | 'stale_unassigned'
  | 'active_workload_high'
  | 'stats_truncated';

export interface ExceptionThresholds {
  /** Warn when unassigned inbox count exceeds this (default 10). */
  unassigned_warning: number;
  /** Critical when unassigned inbox count exceeds this (default 50). */
  unassigned_critical: number;
  /** Flag unassigned queue items older than this many hours (default 48). */
  stale_unassigned_hours: number;
  /** Warn when one person has more than this many active assigned conversations (default 40). */
  active_workload_warning: number;
}

export const DEFAULT_EXCEPTION_THRESHOLDS: ExceptionThresholds = {
  unassigned_warning: 10,
  unassigned_critical: 50,
  stale_unassigned_hours: 48,
  active_workload_warning: 40,
};

export interface InboxException {
  type: InboxExceptionType;
  severity: ExceptionSeverity;
  message: string;
  conversation_id?: string;
  subject?: string;
  details?: Record<string, string | number | boolean | string[]>;
}

export interface TeamInboxStats {
  team: { id: string; name: string };
  as_of: string;
  thresholds: ExceptionThresholds;
  unassigned_inbox: {
    count: number;
    truncated: boolean;
    pages_fetched: number;
    with_attachments: number;
    with_drafts: number;
    queue: UnassignedQueueItem[];
  };
  active_assigned: {
    open_conversations_scanned: number;
    truncated: boolean;
    pages_fetched: number;
    by_assignee: Record<string, number>;
  };
  hot_flags: {
    /** Open conversations with a label matching %hot% (case-insensitive). */
    open_not_closed: HotFlagItem[];
    /** Subset of hot_flags that are also snoozed by at least one user. */
    open_hot_snoozed: HotFlagItem[];
  };
  exceptions: {
    count: number;
    by_severity: Record<ExceptionSeverity, number>;
    items: InboxException[];
  };
}

export function getSharedLabelNames(conversation: Conversation): string[] {
  const names = conversation.shared_label_names;
  if (!names) return [];
  return Array.isArray(names) ? names : [names];
}

export function getHotLabels(
  conversation: Conversation,
  pattern: RegExp = HOT_LABEL_PATTERN
): string[] {
  return getSharedLabelNames(conversation).filter((label) => pattern.test(label));
}

export function isConversationClosed(conversation: Conversation): boolean {
  if (conversation.closed_at) return true;
  const users = conversation.users ?? [];
  if (users.length === 0) return false;
  return users.every((user) => user.closed);
}

export function isActiveAssignedUser(email: string, conversation: Conversation): boolean {
  const user = conversation.users?.find((row) => row.email === email);
  if (!user) return false;
  return Boolean(user.assigned && !user.closed && !user.archived);
}

export function getSnoozedEmails(conversation: Conversation): string[] {
  return (conversation.users ?? [])
    .filter((user) => user.snoozed && user.email)
    .map((user) => user.email as string);
}

export function summarizeHotFlag(conversation: Conversation): HotFlagItem {
  return {
    id: conversation.id,
    subject: conversation.latest_message_subject ?? conversation.subject ?? '',
    hot_labels: getHotLabels(conversation),
    assignees: conversation.assignee_emails ?? '',
    snoozed_by: getSnoozedEmails(conversation),
    last_activity_at: conversation.last_activity_at,
  };
}

export function summarizeUnassignedQueueItem(conversation: Conversation): UnassignedQueueItem {
  return {
    id: conversation.id,
    subject: conversation.latest_message_subject ?? conversation.subject ?? '',
    labels: getSharedLabelNames(conversation),
    attachments: conversation.attachments_count ?? 0,
    messages: conversation.messages_count,
    last_activity_at: conversation.last_activity_at,
    has_draft: (conversation.drafts_count ?? 0) > 0,
  };
}

export async function paginateTeamConversations(
  client: MissiveClient,
  view: 'team_inbox' | 'team_all',
  teamId: string,
  maxPages: number
): Promise<{ conversations: Conversation[]; pagesFetched: number; truncated: boolean }> {
  const conversations: Conversation[] = [];
  let until: string | undefined;
  let pagesFetched = 0;
  let lastPageSize = 0;

  while (pagesFetched < maxPages) {
    const data = await client.get<ConversationsResponse>('/conversations', {
      [view]: teamId,
      limit: 50,
      until,
    });
    const page = data.conversations ?? [];
    lastPageSize = page.length;
    if (page.length === 0) break;

    conversations.push(...page);
    pagesFetched += 1;

    if (page.length < 50) break;
    until = String(page[page.length - 1].last_activity_at);
  }

  return {
    conversations,
    pagesFetched,
    truncated: pagesFetched === maxPages && lastPageSize === 50,
  };
}

export async function resolveTeam(
  client: MissiveClient,
  options: { teamId?: string; teamName?: string; organizationId?: string }
): Promise<Team> {
  if (options.teamId) {
    const teams = await listTeams(client, options.organizationId);
    const team = teams.find((entry) => entry.id === options.teamId);
    if (!team) {
      throw new Error(`Team not found: ${options.teamId}`);
    }
    return team;
  }

  if (!options.teamName) {
    throw new Error('Provide team_id or team_name');
  }

  const teams = await listTeams(client, options.organizationId);
  const needle = options.teamName.trim().toLowerCase();

  const exact = teams.filter((team) => team.name.toLowerCase() === needle);
  if (exact.length === 1) return exact[0];

  const matches = teams.filter((team) => team.name.toLowerCase().includes(needle));

  if (matches.length === 0) {
    throw new Error(`No team matching "${options.teamName}"`);
  }
  if (matches.length > 1) {
    const names = matches.map((team) => team.name).join(', ');
    throw new Error(`Multiple teams match "${options.teamName}": ${names}. Use team_id instead.`);
  }

  return matches[0];
}

async function listTeams(client: MissiveClient, organizationId?: string): Promise<Team[]> {
  let orgId = organizationId;
  if (!orgId) {
    const orgs = await client.get<{ organizations: { id: string }[] }>('/organizations');
    orgId = orgs.organizations[0]?.id;
    if (!orgId) {
      throw new Error('No organizations found for this token');
    }
  }

  const data = await client.get<TeamsResponse>('/teams', {
    organization: orgId,
    limit: 50,
  });
  return data.teams ?? [];
}

function hoursSince(timestamp: number, nowMs: number = Date.now()): number {
  return (nowMs - timestamp * 1000) / (1000 * 60 * 60);
}

export function detectInboxExceptions(
  input: {
    queue: UnassignedQueueItem[];
    unassignedTruncated: boolean;
    openTruncated: boolean;
    openHotFlags: HotFlagItem[];
    openHotSnoozed: HotFlagItem[];
    activeAssigned: Record<string, number>;
  },
  thresholds: ExceptionThresholds = DEFAULT_EXCEPTION_THRESHOLDS,
  nowMs: number = Date.now()
): InboxException[] {
  const exceptions: InboxException[] = [];

  if (input.unassignedTruncated) {
    exceptions.push({
      type: 'stats_truncated',
      severity: 'warning',
      message: 'Unassigned inbox count may be incomplete (pagination limit reached).',
      details: { view: 'team_inbox' },
    });
  }

  if (input.openTruncated) {
    exceptions.push({
      type: 'stats_truncated',
      severity: 'info',
      message: 'Open conversation scan may be incomplete (pagination limit reached).',
      details: { view: 'team_all' },
    });
  }

  const unassignedCount = input.queue.length;
  if (unassignedCount >= thresholds.unassigned_critical) {
    exceptions.push({
      type: 'unassigned_queue_high',
      severity: 'critical',
      message: `${unassignedCount} unassigned conversations in team inbox (threshold: ${thresholds.unassigned_critical}).`,
      details: { count: unassignedCount, threshold: thresholds.unassigned_critical },
    });
  } else if (unassignedCount >= thresholds.unassigned_warning) {
    exceptions.push({
      type: 'unassigned_queue_high',
      severity: 'warning',
      message: `${unassignedCount} unassigned conversations in team inbox (threshold: ${thresholds.unassigned_warning}).`,
      details: { count: unassignedCount, threshold: thresholds.unassigned_warning },
    });
  }

  for (const item of input.queue) {
    const ageHours = hoursSince(item.last_activity_at, nowMs);
    if (ageHours >= thresholds.stale_unassigned_hours) {
      exceptions.push({
        type: 'stale_unassigned',
        severity: ageHours >= thresholds.stale_unassigned_hours * 2 ? 'critical' : 'warning',
        message: `Unassigned inbox item is ${Math.round(ageHours)}h old (threshold: ${thresholds.stale_unassigned_hours}h).`,
        conversation_id: item.id,
        subject: item.subject,
        details: {
          age_hours: Math.round(ageHours),
          threshold_hours: thresholds.stale_unassigned_hours,
          labels: item.labels.join(', '),
        },
      });
    }
  }

  for (const flag of input.openHotFlags) {
    exceptions.push({
      type: 'hot_open',
      severity: 'warning',
      message: `Open conversation has Hot label: ${flag.hot_labels.join(', ')}.`,
      conversation_id: flag.id,
      subject: flag.subject,
      details: {
        hot_labels: flag.hot_labels,
        assignees: flag.assignees,
      },
    });
  }

  for (const flag of input.openHotSnoozed) {
    exceptions.push({
      type: 'hot_snoozed',
      severity: 'critical',
      message: `Hot conversation is snoozed by ${flag.snoozed_by.join(', ')}.`,
      conversation_id: flag.id,
      subject: flag.subject,
      details: {
        hot_labels: flag.hot_labels,
        snoozed_by: flag.snoozed_by,
        assignees: flag.assignees,
      },
    });
  }

  for (const [email, count] of Object.entries(input.activeAssigned)) {
    if (count >= thresholds.active_workload_warning) {
      exceptions.push({
        type: 'active_workload_high',
        severity: count >= thresholds.active_workload_warning * 2 ? 'critical' : 'warning',
        message: `${email} has ${count} active assigned conversations (threshold: ${thresholds.active_workload_warning}).`,
        details: {
          email,
          count,
          threshold: thresholds.active_workload_warning,
        },
      });
    }
  }

  const severityRank: Record<ExceptionSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };

  return exceptions.sort((a, b) => {
    const bySeverity = severityRank[a.severity] - severityRank[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return a.type.localeCompare(b.type);
  });
}

function summarizeExceptions(items: InboxException[]): TeamInboxStats['exceptions'] {
  const bySeverity: Record<ExceptionSeverity, number> = {
    critical: 0,
    warning: 0,
    info: 0,
  };

  for (const item of items) {
    bySeverity[item.severity] += 1;
  }

  return {
    count: items.length,
    by_severity: bySeverity,
    items,
  };
}

export async function buildTeamInboxStats(
  client: MissiveClient,
  team: Team,
  maxPages: number,
  thresholds: ExceptionThresholds = DEFAULT_EXCEPTION_THRESHOLDS
): Promise<TeamInboxStats> {
  const [inboxPage, openPage] = await Promise.all([
    paginateTeamConversations(client, 'team_inbox', team.id, maxPages),
    paginateTeamConversations(client, 'team_all', team.id, maxPages),
  ]);

  const queue = inboxPage.conversations
    .map(summarizeUnassignedQueueItem)
    .sort((a, b) => a.last_activity_at - b.last_activity_at);

  const activeAssigned: Record<string, number> = {};
  const seenEmails = new Set<string>();

  for (const conversation of openPage.conversations) {
    for (const user of conversation.users ?? []) {
      if (!user.email || !isActiveAssignedUser(user.email, conversation)) continue;
      seenEmails.add(user.email);
      activeAssigned[user.email] = (activeAssigned[user.email] ?? 0) + 1;
    }
  }

  const sortedAssignees = Object.fromEntries(
    Object.entries(activeAssigned).sort(([, a], [, b]) => b - a)
  );

  const openHotFlags = openPage.conversations
    .filter((conversation) => getHotLabels(conversation).length > 0 && !isConversationClosed(conversation))
    .map(summarizeHotFlag);

  const openHotSnoozed = openHotFlags.filter((flag) => flag.snoozed_by.length > 0);

  const exceptionItems = detectInboxExceptions(
    {
      queue,
      unassignedTruncated: inboxPage.truncated,
      openTruncated: openPage.truncated,
      openHotFlags,
      openHotSnoozed,
      activeAssigned: sortedAssignees,
    },
    thresholds
  );

  return {
    team: { id: team.id, name: team.name },
    as_of: new Date().toISOString(),
    thresholds,
    unassigned_inbox: {
      count: queue.length,
      truncated: inboxPage.truncated,
      pages_fetched: inboxPage.pagesFetched,
      with_attachments: queue.filter((item) => item.attachments > 0).length,
      with_drafts: queue.filter((item) => item.has_draft).length,
      queue,
    },
    active_assigned: {
      open_conversations_scanned: openPage.conversations.length,
      truncated: openPage.truncated,
      pages_fetched: openPage.pagesFetched,
      by_assignee: sortedAssignees,
    },
    hot_flags: {
      open_not_closed: openHotFlags,
      open_hot_snoozed: openHotSnoozed,
    },
    exceptions: summarizeExceptions(exceptionItems),
  };
}
