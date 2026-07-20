/* prettier-ignore */

/**
 * Hand-rolled Linear roadmap fixture for the mock client. Used by local
 * dev and E2E. Realistic enough that the constellation renders populated
 * and the Lightning Fuse / Sonar Ping animations have something to play
 * across — multiple projects, parent/child issues, cross-project
 * dependencies, a mix of statuses and types.
 *
 * Committed as a TypeScript constant (not JSON) so it bundles identically
 * across Wrangler and Vitest with no loader configuration. Matches the
 * convention documented in apps/api/src/services/ai/mock-fixtures/README.md.
 *
 * Mock ids are stable strings prefixed `mock-` so test assertions can pin
 * them. The pipeline replaces every id with an opaque sha-256 prefix
 * before the response leaves the worker.
 */

import type { LinearIssue, LinearProject } from '../types.js';

export const MOCK_PROJECTS: readonly LinearProject[] = [
  {
    id: 'mock-proj-prompts',
    name: 'Custom system prompts',
    color: '#ec4755',
    stateType: 'started',
  },
  {
    id: 'mock-proj-groups',
    name: 'Group chats',
    color: '#3b82f6',
    stateType: 'started',
  },
  {
    id: 'mock-proj-voice',
    name: 'Voice messages',
    color: '#8b5cf6',
    stateType: 'planned',
  },
  {
    id: 'mock-proj-search',
    name: 'Search v2',
    color: '#10b981',
    stateType: 'completed',
  },
];

export const MOCK_ISSUES: readonly LinearIssue[] = [
  // ─── Custom system prompts (started) ──────────────────────────────
  {
    id: 'mock-iss-prompts-presets',
    title: 'Save and reuse prompt presets',
    stateName: 'In Progress',
    stateType: 'started',
    labelNames: ['type:feature'],
    parentId: null,
    projectId: 'mock-proj-prompts',
    relations: [],
  },
  {
    id: 'mock-iss-prompts-presets-list',
    title: 'Preset list UI',
    stateName: 'In Progress',
    stateType: 'started',
    labelNames: ['type:feature'],
    parentId: 'mock-iss-prompts-presets',
    projectId: 'mock-proj-prompts',
    relations: [],
  },
  {
    id: 'mock-iss-prompts-presets-apply',
    title: 'Apply preset to new conversation',
    stateName: 'Todo',
    stateType: 'unstarted',
    labelNames: ['type:feature'],
    parentId: 'mock-iss-prompts-presets',
    projectId: 'mock-proj-prompts',
    relations: [],
  },
  {
    id: 'mock-iss-prompts-fix-delete',
    title: 'Fix preset deletion not clearing local state',
    stateName: 'In Review',
    stateType: 'started',
    labelNames: ['type:bug'],
    parentId: 'mock-iss-prompts-presets',
    projectId: 'mock-proj-prompts',
    relations: [],
  },

  // ─── Group chats (started) ────────────────────────────────────────
  {
    id: 'mock-iss-groups-presence',
    title: 'Group chat presence indicators',
    stateName: 'In Progress',
    stateType: 'started',
    labelNames: ['type:feature'],
    parentId: null,
    projectId: 'mock-proj-groups',
    relations: [],
  },
  {
    id: 'mock-iss-groups-typing',
    title: 'Typing indicators',
    stateName: 'Todo',
    stateType: 'unstarted',
    labelNames: ['type:feature'],
    parentId: 'mock-iss-groups-presence',
    projectId: 'mock-proj-groups',
    relations: [{ type: 'blocked_by', relatedIssueId: 'mock-iss-voice-sync' }],
  },
  {
    id: 'mock-iss-groups-avatars',
    title: 'Online member avatars',
    stateName: 'Todo',
    stateType: 'unstarted',
    labelNames: ['type:feature'],
    parentId: 'mock-iss-groups-presence',
    projectId: 'mock-proj-groups',
    relations: [],
  },
  {
    id: 'mock-iss-groups-invite-bug',
    title: 'Fix invite link expiry race',
    stateName: 'Todo',
    stateType: 'unstarted',
    labelNames: ['type:bug'],
    parentId: null,
    projectId: 'mock-proj-groups',
    relations: [],
  },

  // ─── Voice messages (planned) ────────────────────────────────────
  {
    id: 'mock-iss-voice-record',
    title: 'Voice message recording in the browser',
    stateName: 'Todo',
    stateType: 'unstarted',
    labelNames: ['type:feature'],
    parentId: null,
    projectId: 'mock-proj-voice',
    relations: [],
  },
  {
    id: 'mock-iss-voice-sync',
    title: 'Real-time sync layer rewrite',
    stateName: 'Backlog',
    stateType: 'backlog',
    labelNames: ['type:feature'],
    parentId: null,
    projectId: 'mock-proj-voice',
    relations: [],
  },

  // ─── Search v2 (completed) ────────────────────────────────────────
  {
    id: 'mock-iss-search-cmdk',
    title: 'Command palette across all conversations',
    stateName: 'Done',
    stateType: 'completed',
    labelNames: ['type:feature'],
    parentId: null,
    projectId: 'mock-proj-search',
    relations: [],
  },
  {
    id: 'mock-iss-search-highlight',
    title: 'Highlight matched text in results',
    stateName: 'Done',
    stateType: 'completed',
    labelNames: ['type:feature'],
    parentId: 'mock-iss-search-cmdk',
    projectId: 'mock-proj-search',
    relations: [],
  },
  {
    id: 'mock-iss-search-fix-unicode',
    title: 'Fix Unicode normalization in search index',
    stateName: 'Done',
    stateType: 'completed',
    labelNames: ['type:bug'],
    parentId: null,
    projectId: 'mock-proj-search',
    relations: [],
  },

  // ─── Orphan issue (no project) ────────────────────────────────────
  {
    id: 'mock-iss-orphan-notif',
    title: 'Push notification batching',
    stateName: 'Todo',
    stateType: 'unstarted',
    labelNames: ['type:feature'],
    parentId: null,
    projectId: null,
    relations: [{ type: 'blocks', relatedIssueId: 'mock-iss-groups-typing' }],
  },
];
