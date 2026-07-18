import { writeFile as fsWriteFile } from 'node:fs/promises';

import { LinearClient } from '@linear/sdk';
import { LINEAR_TEAM_ID } from '@hushbox/shared/linear';

import { isMainModule } from '../lib/is-main.js';
import { runMain } from '../lib/run-main.js';
import { fetchBoard, requireEnv, withBackoff } from './client.js';
import { countUngroomed, groomedHash, validateBackup } from './validate.js';

import type {
  BoardSource,
  IssueCreateInput,
  IssueUpdateInput,
  ProjectCreateInput,
  WritePayload,
  WriteSource,
} from './client.js';
import type { Backup } from './schema.js';

/**
 * Injected effects for the CLI. Kept as dependencies so tests exercise dispatch
 * and validation with an in-memory board and no live Linear network or disk.
 */
export interface MainDeps {
  fetchBoard: () => Promise<Backup>;
  writeFile: (path: string, data: string) => Promise<void>;
  writeClient: WriteSource;
  log: (message: string) => void;
}

/**
 * Linear priority is an integer, NOT a severity scale: 0 = none, 1 = urgent,
 * 2 = high, 3 = medium, 4 = low. The CLI takes the name and maps it here.
 */
const PRIORITY_BY_NAME: Record<string, number> = {
  none: 0,
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
};

/** Read a flag's value, throwing a clear error when it is absent. */
function requireValue(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing required flag: ${name}`);
  }
  return value;
}

/** Read an optional flag's value; undefined when the flag is absent. */
function optionalValue(argv: string[], name: string): string | undefined {
  return argv.includes(name) ? requireValue(argv, name) : undefined;
}

/** Gather every value of a repeatable flag, in order. */
function collectValues(argv: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for flag: ${name}`);
      }
      values.push(value);
    }
  }
  return values;
}

/** Map a priority name to its Linear integer, rejecting unknown names. */
function parsePriority(raw: string): number {
  const priority = PRIORITY_BY_NAME[raw.toLowerCase()];
  if (priority === undefined) {
    throw new Error(`Invalid --priority: ${raw} (expected none|urgent|high|medium|low)`);
  }
  return priority;
}

/** Parse a non-negative integer estimate, rejecting anything else. */
function parseEstimate(raw: string): number {
  const estimate = Number(raw);
  if (!Number.isInteger(estimate) || estimate < 0) {
    throw new TypeError(`Invalid --estimate: ${raw}`);
  }
  return estimate;
}

/** Run a write through the rate-limit policy and reject a `success: false` payload. */
async function submit(action: string, call: () => Promise<WritePayload>): Promise<void> {
  const payload = await withBackoff(call);
  if (!payload.success) {
    throw new Error(`Linear write failed: ${action}`);
  }
}

async function runBackup(argv: string[], deps: MainDeps): Promise<void> {
  const out = requireValue(argv, '--out');
  const previousCountIndex = argv.indexOf('--prev-count');
  let previousCount: number | undefined;
  if (previousCountIndex !== -1) {
    const raw = requireValue(argv, '--prev-count');
    previousCount = Number(raw);
    if (!Number.isFinite(previousCount)) {
      throw new TypeError(`Invalid --prev-count: ${raw}`);
    }
  }
  const allowShrink = argv.includes('--allow-shrink');

  const board = await deps.fetchBoard();
  const serialized = JSON.stringify(board, null, 2);
  // Write before validating: the artifact must survive to disk even when
  // validation later rejects it, so a human can inspect what was fetched.
  await deps.writeFile(out, serialized);

  const validated = validateBackup(JSON.parse(serialized), {
    prevCount: previousCount,
    allowShrink,
  });
  deps.log(`Backed up ${String(validated.issues.length)} issues to ${out}`);
}

/**
 * Apply the fields shared by issue create and update — description, estimate,
 * priority, project, state — setting only those the caller supplied. Shared so
 * the two builders don't drift.
 */
function applyCommonIssueFields(
  argv: string[],
  input: {
    description?: string;
    estimate?: number;
    priority?: number;
    projectId?: string;
    stateId?: string;
  }
): void {
  const description = optionalValue(argv, '--description');
  if (description !== undefined) input.description = description;
  const estimate = optionalValue(argv, '--estimate');
  if (estimate !== undefined) input.estimate = parseEstimate(estimate);
  const priority = optionalValue(argv, '--priority');
  if (priority !== undefined) input.priority = parsePriority(priority);
  const project = optionalValue(argv, '--project');
  if (project !== undefined) input.projectId = project;
  const state = optionalValue(argv, '--state');
  if (state !== undefined) input.stateId = state;
}

/** Build an additive issue update from flags — only fields the caller supplied. */
function buildUpdateInput(argv: string[]): IssueUpdateInput {
  const input: IssueUpdateInput = {};
  const title = optionalValue(argv, '--title');
  if (title !== undefined) input.title = title;
  applyCommonIssueFields(argv, input);
  const added = collectValues(argv, '--add-label');
  if (added.length > 0) input.addedLabelIds = added;
  const removed = collectValues(argv, '--remove-label');
  if (removed.length > 0) input.removedLabelIds = removed;
  return input;
}

/** Build a create-issue input; the HUS team id is supplied automatically. */
function buildCreateInput(argv: string[]): IssueCreateInput {
  const input: IssueCreateInput = {
    teamId: LINEAR_TEAM_ID,
    title: requireValue(argv, '--title'),
  };
  applyCommonIssueFields(argv, input);
  const labels = collectValues(argv, '--label');
  if (labels.length > 0) input.labelIds = labels;
  return input;
}

/** Build a create-project input; the HUS team id is supplied automatically. */
function buildProjectInput(argv: string[]): ProjectCreateInput {
  const input: ProjectCreateInput = {
    name: requireValue(argv, '--name'),
    teamIds: [LINEAR_TEAM_ID],
  };
  const description = optionalValue(argv, '--description');
  if (description !== undefined) input.description = description;
  return input;
}

async function runUpdateIssue(rest: string[], deps: MainDeps, dryRun: boolean): Promise<void> {
  const id = requireValue(rest, '--id');
  const input = buildUpdateInput(rest);
  if (dryRun) {
    deps.log(`[dry-run] updateIssue ${id} ${JSON.stringify(input)}`);
    return;
  }
  await submit(`updateIssue ${id}`, () => deps.writeClient.updateIssue(id, input));
  deps.log(`Updated ${id}`);
}

async function runCreateIssue(rest: string[], deps: MainDeps, dryRun: boolean): Promise<void> {
  const input = buildCreateInput(rest);
  if (dryRun) {
    deps.log(`[dry-run] createIssue ${JSON.stringify(input)}`);
    return;
  }
  await submit('createIssue', () => deps.writeClient.createIssue(input));
  deps.log(`Created issue "${input.title}"`);
}

async function runCreateComment(rest: string[], deps: MainDeps, dryRun: boolean): Promise<void> {
  const issueId = requireValue(rest, '--issue');
  const body = requireValue(rest, '--body');
  if (dryRun) {
    deps.log(`[dry-run] createComment ${JSON.stringify({ issueId, body })}`);
    return;
  }
  await submit('createComment', () => deps.writeClient.createComment({ issueId, body }));
  deps.log(`Commented on ${issueId}`);
}

async function runCreateProject(rest: string[], deps: MainDeps, dryRun: boolean): Promise<void> {
  const input = buildProjectInput(rest);
  if (dryRun) {
    deps.log(`[dry-run] createProject ${JSON.stringify(input)}`);
    return;
  }
  await submit('createProject', () => deps.writeClient.createProject(input));
  deps.log(`Created project "${input.name}"`);
}

/** Dispatch a single CLI invocation. Returns nothing; throws on any failure. */
export async function main(argv: string[], deps: MainDeps): Promise<void> {
  const [command, ...rest] = argv;
  const dryRun = rest.includes('--dry-run');

  switch (command) {
    case 'backup': {
      return runBackup(rest, deps);
    }
    case 'count-ungroomed': {
      const board = await deps.fetchBoard();
      deps.log(String(countUngroomed(board)));
      return;
    }
    case 'hash': {
      deps.log(groomedHash(requireValue(rest, '--title'), requireValue(rest, '--description')));
      return;
    }
    case 'update-issue': {
      return runUpdateIssue(rest, deps, dryRun);
    }
    case 'create-issue': {
      return runCreateIssue(rest, deps, dryRun);
    }
    case 'create-comment': {
      return runCreateComment(rest, deps, dryRun);
    }
    case 'create-project': {
      return runCreateProject(rest, deps, dryRun);
    }
    default: {
      throw new Error(command ? `Unknown command: ${command}` : 'Missing command');
    }
  }
}

/* v8 ignore start -- CLI wiring; dispatch, fetch, and validation tested with mocks */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const client = new LinearClient({ apiKey: requireEnv('LINEAR_API_KEY_WRITE') });
    const source: BoardSource = {
      issues: (variables) => client.issues(variables),
      projects: (variables) => client.projects(variables),
      issueLabels: (variables) => client.issueLabels(variables),
      workflowStates: (variables) => client.workflowStates(variables),
    };
    const writeClient: WriteSource = {
      updateIssue: (id, input) => client.updateIssue(id, input),
      createIssue: (input) => client.createIssue(input),
      createComment: (input) => client.createComment(input),
      createProject: (input) => client.createProject(input),
    };
    await main(process.argv.slice(2), {
      fetchBoard: () => fetchBoard(source),
      writeFile: (path, data) => fsWriteFile(path, data, 'utf8'),
      writeClient,
      log: (message) => {
        console.log(message);
      },
    });
  });
}
/* v8 ignore stop */
