import { Node, SyntaxKind } from 'ts-morph';
import type {
  CallExpression,
  Project,
  SourceFile,
  TaggedTemplateExpression,
  TemplateExpression,
} from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Single-writer-per-table, structurally enforced. Every table has exactly one
 * owning slice; every other slice reaches it through the owner's published
 * barrel API (ARCHITECTURE.md §System map). Lint boundaries see imports, not
 * which table a `db.insert(...)` targets, so this rule closes that gap: it
 * attributes each write to the writing slice and the written table and fails
 * when the two disagree with `TABLE_OWNER`.
 *
 * The table set is derived at check time from the schema barrel
 * (`packages/db/src/schema/index.ts`) so a renamed or dropped table cannot
 * silently desync the map — a missing owner or a stale key is itself a
 * violation. Sentinel owners `'lib'` and `'db'` are deliberately non-slice
 * values, so any slice writing an infra table (`jobs`, `idempotency_keys`,
 * `service_evidence`) is flagged.
 *
 * Syntactic only (no `getType()`): query-builder writes are
 * `.insert/.update/.delete(TABLE)` with a bare table identifier as the first
 * argument (which alone excludes Hono route verbs, `Set.delete`, and
 * `storage.delete`); raw-SQL writes are `sql`…`` DML tagged templates
 * interpolating a table identifier.
 */

const SCHEMA_BARREL_SUFFIX = 'packages/db/src/schema/index.ts';
const SLICES_SEGMENT = 'apps/api/src/slices/';

/**
 * The owning slice of every table. Sentinel owners `'lib'` and `'db'` are
 * intentionally not slice names. Keys and the derived schema set must match
 * exactly — completeness is asserted below in both directions.
 */
const TABLE_OWNER: Record<string, string | string[]> = {
  users: 'identity',
  verificationTokens: 'identity',
  accountDeletionEvents: 'identity',
  wallets: 'billing',
  ledgerEntries: 'billing',
  usageRecords: 'billing',
  llmCompletions: 'billing',
  mediaGenerations: 'billing',
  payments: 'billing',
  memberBudgets: 'billing',
  conversationSpending: 'billing',
  allowanceSpending: 'billing',
  publicStatsSnapshots: 'billing',
  conversations: 'conversations',
  conversationMembers: 'conversations',
  conversationForks: 'conversations',
  epochs: 'conversations',
  epochMembers: 'conversations',
  sharedLinks: 'conversations',
  sharedMessages: 'conversations',
  messages: 'chat',
  contentItems: 'chat',
  modelCatalog: 'models',
  newsletterSubscribers: 'newsletter',
  newsletterIssues: 'newsletter',
  newsletterDeliveries: 'newsletter',
  adminAudit: 'admin',
  deviceTokens: 'notifications',
  feedback: 'feedback',
  customInstructions: 'account',
  preferences: 'account',
  bannerConfig: 'announcements',
  bannerDismissals: 'announcements',
  idempotencyKeys: 'lib',
  jobs: 'lib',
  serviceEvidence: 'db',
};

const WRITE_METHODS = new Set(['insert', 'update', 'delete']);
const DML = /INSERT INTO|UPDATE|DELETE FROM/i;

function normalize(sourceFile: SourceFile): string {
  return sourceFile.getFilePath().replace(/^\//, '');
}

/**
 * The live table-export set with each export's line. Named exports from
 * `./enums` and `./relations` are excluded, plus a defensive drop of any name
 * ending `Enum`/`Relations`.
 */
function deriveSchemaTables(barrel: SourceFile): Map<string, number> {
  const tables = new Map<string, number>();
  for (const declaration of barrel.getExportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    if (specifier === './enums' || specifier === './relations') continue;
    for (const named of declaration.getNamedExports()) {
      const name = named.getName();
      if (name.endsWith('Enum') || name.endsWith('Relations')) continue;
      tables.set(name, named.getStartLineNumber());
    }
  }
  return tables;
}

/** Missing-owner and stale-key violations, anchored to the schema barrel. */
function completenessViolations(tables: Map<string, number>, barrelPath: string): ArchViolation[] {
  const violations: ArchViolation[] = [];
  for (const [table, line] of tables) {
    if (!(table in TABLE_OWNER)) {
      violations.push({
        file: barrelPath,
        line,
        message: `table '${table}' has no owning slice — add it to TABLE_OWNER`,
      });
    }
  }
  for (const key of Object.keys(TABLE_OWNER)) {
    if (!tables.has(key)) {
      violations.push({
        file: barrelPath,
        line: 1,
        message: `TABLE_OWNER lists '${key}' which no longer exists in the schema — remove or rename it`,
      });
    }
  }
  return violations;
}

function sliceOf(filePath: string): string {
  const afterSlices = filePath.slice(filePath.indexOf(SLICES_SEGMENT) + SLICES_SEGMENT.length);
  return afterSlices.split('/')[0] ?? '';
}

/** Normalizes a `string | string[]` owner to an array without a branch. */
function ownersOf(owner: string | string[]): string[] {
  return [owner].flat();
}

function writeViolation(
  table: string,
  slice: string,
  filePath: string,
  line: number
): ArchViolation | undefined {
  const owner = TABLE_OWNER[table];
  if (owner === undefined) return undefined;
  const owners = ownersOf(owner);
  if (owners.includes(slice)) return undefined;
  return {
    file: filePath,
    line,
    message: `slice '${slice}' writes table '${table}', owned by '${owners.join("' or '")}' — go through its published barrel API`,
  };
}

/** The table named by a `.insert/.update/.delete(TABLE)` call, if any. */
function queryBuilderTable(call: CallExpression, tables: Map<string, number>): string | undefined {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return undefined;
  if (!WRITE_METHODS.has(callee.getName())) return undefined;
  const firstArgument = call.getArguments()[0];
  if (firstArgument === undefined || !Node.isIdentifier(firstArgument)) return undefined;
  const name = firstArgument.getText();
  return tables.has(name) ? name : undefined;
}

/** The tagged template, if it is a `sql`…`` DML template with interpolation. */
function dmlSqlTemplate(tagged: TaggedTemplateExpression): TemplateExpression | undefined {
  const tag = tagged.getTag();
  if (!Node.isIdentifier(tag)) return undefined;
  if (tag.getText() !== 'sql') return undefined;
  const template = tagged.getTemplate();
  if (!Node.isTemplateExpression(template)) return undefined;
  if (!DML.test(template.getText())) return undefined;
  return template;
}

/** Table identifiers interpolated into a DML `sql`…`` tagged template. */
function rawSqlTables(tagged: TaggedTemplateExpression, tables: Map<string, number>): string[] {
  const template = dmlSqlTemplate(tagged);
  if (template === undefined) return [];
  const found: string[] = [];
  for (const span of template.getTemplateSpans()) {
    const expression = span.getExpression();
    if (Node.isIdentifier(expression) && tables.has(expression.getText())) {
      found.push(expression.getText());
    }
  }
  return found;
}

function queryBuilderViolations(
  sourceFile: SourceFile,
  filePath: string,
  slice: string,
  tables: Map<string, number>
): ArchViolation[] {
  const violations: ArchViolation[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const table = queryBuilderTable(call, tables);
    if (table === undefined) continue;
    const violation = writeViolation(table, slice, filePath, call.getStartLineNumber());
    if (violation !== undefined) violations.push(violation);
  }
  return violations;
}

function rawSqlViolations(
  sourceFile: SourceFile,
  filePath: string,
  slice: string,
  tables: Map<string, number>
): ArchViolation[] {
  const violations: ArchViolation[] = [];
  for (const tagged of sourceFile.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression)) {
    for (const table of rawSqlTables(tagged, tables)) {
      const violation = writeViolation(table, slice, filePath, tagged.getStartLineNumber());
      if (violation !== undefined) violations.push(violation);
    }
  }
  return violations;
}

function sliceWriteViolations(
  sourceFile: SourceFile,
  filePath: string,
  tables: Map<string, number>
): ArchViolation[] {
  const slice = sliceOf(filePath);
  return [
    ...queryBuilderViolations(sourceFile, filePath, slice, tables),
    ...rawSqlViolations(sourceFile, filePath, slice, tables),
  ];
}

const rule: ArchRule = {
  name: 'single-writer-per-table',
  check(project: Project): ArchViolation[] {
    const barrel = project
      .getSourceFiles()
      .find((sourceFile) => normalize(sourceFile).endsWith(SCHEMA_BARREL_SUFFIX));
    if (barrel === undefined) {
      throw new Error(
        `single-writer-per-table: schema barrel '${SCHEMA_BARREL_SUFFIX}' not found in project`
      );
    }

    const tables = deriveSchemaTables(barrel);
    const violations: ArchViolation[] = completenessViolations(tables, normalize(barrel));

    for (const sourceFile of project.getSourceFiles()) {
      const filePath = normalize(sourceFile);
      if (!filePath.includes(SLICES_SEGMENT)) continue;
      if (filePath.endsWith('.test.ts')) continue;
      violations.push(...sliceWriteViolations(sourceFile, filePath, tables));
    }

    return violations;
  },
};

export default rule;
