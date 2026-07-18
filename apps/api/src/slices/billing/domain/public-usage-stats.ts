import {
  MODALITIES,
  PUBLIC_USAGE_STATS_SCHEMA_VERSION,
  USAGE_STATS_WINDOWS,
  publicUsageStatsSchema,
} from '@hushbox/shared';
import { validationError } from '../../../lib/errors/index.js';
import { ResultAsync, err, errAsync, ok } from '../../../lib/result/index.js';
import { roundHalfEvenDiv } from './money.js';
import type { Database } from '@hushbox/db';
import type {
  Modality,
  PublicUsageStats,
  UsageStatsWindow,
  UsageStatsWindowStats,
} from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Result } from '../../../lib/result/index.js';
import type {
  GlobalCostPercentiles,
  GlobalModelUsageRow,
  GlobalTrendCountRow,
  PublicStatsSnapshotRow,
  PublicStatsStores,
} from '../ports/public-stats.js';

/**
 * The anonymization boundary of the public usage-stats feature. Raw global
 * counts enter here from the store queries, exist only in this module's local
 * variables, and leave only as percent shares and per-message cost strings.
 * Nothing count-like may ever be returned, persisted, or logged from here.
 */

const DAY_MS = 86_400_000;

/**
 * Below this many records in a (window, modality), shares round to whole
 * percents instead of one decimal — a tenth of a percent of a small sample is
 * noise, and coarser rounding also leaks less about the underlying count.
 * Internal only; never exposed in the payload.
 */
const WHOLE_PERCENT_MIN_SAMPLE = 1000;

/** Models below this exact share of a (window, modality) fold into Others. */
const OTHERS_FOLD_PERCENT = 2;

/** Cost strings carry at most this many significant digits. */
const COST_SIGNIFICANT_DIGITS = 4;

export interface PublicStatsModelMeta {
  readonly displayName: string;
  readonly provider: string;
}

export interface BuildPublicUsageStatsDeps {
  readonly db: Database;
  readonly stores: PublicStatsStores;
  /** The injected clock: window anchor and `generatedAt`. */
  readonly now: Date;
  /**
   * Display metadata for model ids, injected because model_catalog is
   * models-slice-owned — billing never touches another slice's schema
   * objects. Ids missing from the map render as the raw id.
   */
  readonly resolveModelMeta: (
    modelIds: readonly string[]
  ) => ResultAsync<ReadonlyMap<string, PublicStatsModelMeta>, DomainError>;
}

type Precision = 'tenth' | 'whole';

function invariant(message: string): DomainError {
  return validationError(`public usage stats invariant violated: ${message}`);
}

/** One apportionment participant: `assign` receives its final share in tenths. */
interface ShareParticipant {
  /** Tie-break key (model id); Others is internal and always loses ties. */
  readonly key: string;
  readonly count: number;
  readonly assign: (tenths: number) => void;
}

/**
 * Largest-remainder apportionment in integer units of the precision step
 * (tenths of a percent, or whole percents for thin windows): floor every
 * participant's exact share, then hand the leftover units one at a time to
 * the largest fractional remainders (ties: larger exact share, then model id,
 * Others last). Every legal distribution therefore sums to exactly 100 —
 * the sum gate below can only trip on corrupt inputs. Others participates
 * with the true combined count of the folded models, never as a subtraction
 * artifact. Returns the Others share in tenths.
 */
function apportionShareTenths(
  models: readonly ShareParticipant[],
  othersCount: number,
  total: number,
  precision: Precision
): number {
  const totalUnits = precision === 'tenth' ? 1000 : 100;
  const scale = 1000 / totalUnits;
  if (total === 0) {
    // An empty trend bucket: no participant has any exact share, so Others
    // carries the full 100 and every model renders 0.
    for (const model of models) model.assign(0);
    return 1000;
  }
  interface Cell {
    readonly key: string;
    readonly isOthers: boolean;
    readonly exact: number;
    units: number;
    readonly assign: (tenths: number) => void;
  }
  let othersTenths = 0;
  const toCell = (participant: ShareParticipant, isOthers: boolean): Cell => {
    const exact = (participant.count * totalUnits) / total;
    return {
      key: participant.key,
      isOthers,
      exact,
      units: Math.floor(exact),
      assign: participant.assign,
    };
  };
  const cells = [
    ...models.map((model) => toCell(model, false)),
    toCell(
      {
        key: '',
        count: othersCount,
        assign: (tenths) => {
          othersTenths = tenths;
        },
      },
      true
    ),
  ];
  let remaining = totalUnits - cells.reduce((sum, cell) => sum + cell.units, 0);
  const byRemainder = cells.toSorted(
    (a, b) =>
      b.exact - b.units - (a.exact - a.units) ||
      b.exact - a.exact ||
      Number(a.isOthers) - Number(b.isOthers) ||
      a.key.localeCompare(b.key)
  );
  for (const cell of byRemainder) {
    if (remaining <= 0) break;
    cell.units += 1;
    remaining -= 1;
  }
  for (const cell of cells) cell.assign(cell.units * scale);
  return othersTenths;
}

/**
 * Write-gate for one models+others list: every share in range, sum exactly
 * 100. Largest-remainder apportionment satisfies both for every legal input,
 * so a trip here means corrupt aggregates (e.g. negative counts) — exported
 * for direct tests because the sum arm is unreachable through the store seam
 * by construction.
 */
export function gateShareList(
  displayedTenths: readonly number[],
  othersTenths: number
): Result<void, DomainError> {
  for (const tenths of [...displayedTenths, othersTenths]) {
    if (tenths < 0 || tenths > 1000) return err(invariant('share outside [0, 100]'));
  }
  const sum = displayedTenths.reduce((total, tenths) => total + tenths, 0) + othersTenths;
  if (sum !== 1000) return err(invariant('share list does not sum to 100'));
  return ok();
}

function roundToSignificant(value: bigint, digits: number): bigint {
  const rendered = value.toString();
  if (rendered.length <= digits) return value;
  const divisor = 10n ** BigInt(rendered.length - digits);
  return roundHalfEvenDiv(value, divisor) * divisor;
}

/** Nano-USD → plain decimal USD string ("0.1235"), trailing zeros stripped. */
function nanoUsdToUsdString(nanoUsd: bigint): string {
  const significant = roundToSignificant(nanoUsd, COST_SIGNIFICANT_DIGITS);
  const whole = significant / 1_000_000_000n;
  const fraction = (significant % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole.toString()}.${fraction}`;
}

function isoDateOfUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The contiguous UTC bucket starts covering `[from, to]`, truncated ends included. */
function expectedBucketStarts(window: UsageStatsWindow, from: Date, to: Date): readonly string[] {
  const starts: string[] = [];
  if (window.trendBucket === 'day') {
    const endMs = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
    for (
      let ms = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
      ms <= endMs;
      ms += DAY_MS
    ) {
      starts.push(isoDateOfUtcMs(ms));
    }
    return starts;
  }
  let year = from.getUTCFullYear();
  let month = from.getUTCMonth();
  const endYear = to.getUTCFullYear();
  const endMonth = to.getUTCMonth();
  while (year < endYear || (year === endYear && month <= endMonth)) {
    starts.push(isoDateOfUtcMs(Date.UTC(year, month, 1)));
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }
  return starts;
}

/** The displayed set: exact share ≥ the fold threshold, largest count first. */
function displayedModels(
  rows: readonly GlobalModelUsageRow[],
  total: number
): readonly GlobalModelUsageRow[] {
  return rows
    .filter((row) => row.messageCount * (100 / OTHERS_FOLD_PERCENT) >= total)
    .toSorted((a, b) => b.messageCount - a.messageCount || a.modelId.localeCompare(b.modelId));
}

/** One (window, modality) total and the rounding precision it dictates. */
function windowTotals(rows: readonly GlobalModelUsageRow[]): {
  readonly total: number;
  readonly precision: Precision;
} {
  const total = rows.reduce((sum, row) => sum + row.messageCount, 0);
  return { total, precision: total < WHOLE_PERCENT_MIN_SAMPLE ? 'whole' : 'tenth' };
}

interface RawWindowData {
  readonly window: UsageStatsWindow;
  readonly rows: readonly GlobalModelUsageRow[];
  readonly percentiles: GlobalCostPercentiles | null;
  readonly trendRows: readonly GlobalTrendCountRow[];
  /** Prior equal-length window rows; null when the window carries no deltas. */
  readonly priorRows: readonly GlobalModelUsageRow[] | null;
}

function buildCost(
  rows: readonly GlobalModelUsageRow[],
  percentiles: GlobalCostPercentiles | null,
  total: number
): Result<UsageStatsWindowStats['cost'], DomainError> {
  if (percentiles === null) {
    return err(invariant('cost percentiles missing for a non-empty window'));
  }
  const totalCost = rows.reduce((sum, row) => sum + row.costNanoUsd, 0n);
  return ok({
    avgUsd: nanoUsdToUsdString(roundHalfEvenDiv(totalCost, BigInt(total))),
    // percentile_cont interpolates in double precision — a display statistic,
    // never settlement math; rounded to whole nano-USD before formatting.
    medianUsd: nanoUsdToUsdString(BigInt(Math.round(percentiles.medianNanoUsd))),
    p90Usd: nanoUsdToUsdString(BigInt(Math.round(percentiles.p90NanoUsd))),
  });
}

/** The window a trend series spans: bounded windows anchor at `now − days`; the all-time window starts at its earliest recorded bucket. */
function trendWindowStart(raw: RawWindowData, now: Date): Date {
  if (raw.window.days !== null) return new Date(now.getTime() - raw.window.days * DAY_MS);
  let earliest: string | undefined;
  for (const row of raw.trendRows) {
    if (earliest === undefined || row.bucketStart < earliest) earliest = row.bucketStart;
  }
  return new Date(`${earliest ?? isoDateOfUtcMs(now.getTime())}T00:00:00.000Z`);
}

type TrendPoint = UsageStatsWindowStats['trend']['points'][number];

function trendPoint(
  start: string,
  bucketRows: readonly GlobalTrendCountRow[],
  displayed: readonly GlobalModelUsageRow[],
  precision: Precision
): Result<TrendPoint, DomainError> {
  const bucketTotal = bucketRows.reduce((sum, row) => sum + row.messageCount, 0);
  const shares = displayed.map((model) => ({
    modelId: model.modelId,
    count: bucketRows.find((row) => row.modelId === model.modelId)?.messageCount ?? 0,
    tenths: 0,
  }));
  const displayedTotal = shares.reduce((sum, share) => sum + share.count, 0);
  const othersTenths = apportionShareTenths(
    shares.map((share) => ({
      key: share.modelId,
      count: share.count,
      assign: (tenths) => {
        share.tenths = tenths;
      },
    })),
    bucketTotal - displayedTotal,
    bucketTotal,
    precision
  );
  const tenthsList = shares.map((share) => share.tenths);
  const gate = gateShareList(tenthsList, othersTenths);
  if (gate.isErr()) return err(gate.error);
  return ok({
    start,
    models: shares.map((share) => ({
      modelId: share.modelId,
      sharePercent: share.tenths / 10,
    })),
    othersSharePercent: othersTenths / 10,
  });
}

/** The contiguous trend series over the window's displayed set, write-gated. */
function buildTrend(
  raw: RawWindowData,
  displayed: readonly GlobalModelUsageRow[],
  precision: Precision,
  now: Date
): Result<UsageStatsWindowStats['trend'], DomainError> {
  const bucketStarts = expectedBucketStarts(raw.window, trendWindowStart(raw, now), now);
  const expected = new Set(bucketStarts);
  for (const row of raw.trendRows) {
    if (!expected.has(row.bucketStart)) return err(invariant('trend bucket outside the window'));
  }
  const points: TrendPoint[] = [];
  for (const start of bucketStarts) {
    const point = trendPoint(
      start,
      raw.trendRows.filter((row) => row.bucketStart === start),
      displayed,
      precision
    );
    if (point.isErr()) return err(point.error);
    points.push(point.value);
  }
  return ok({ bucket: raw.window.trendBucket, points });
}

function assembleWindow(
  raw: RawWindowData,
  meta: ReadonlyMap<string, PublicStatsModelMeta>,
  now: Date
): Result<UsageStatsWindowStats, DomainError> {
  const { total, precision } = windowTotals(raw.rows);
  const displayed = displayedModels(raw.rows, total);
  const slots = displayed.map((row) => ({
    row,
    tenths: 0,
    priorTenths: null as number | null,
  }));
  const displayedTotal = displayed.reduce((sum, row) => sum + row.messageCount, 0);
  const othersTenths = apportionShareTenths(
    slots.map((slot) => ({
      key: slot.row.modelId,
      count: slot.row.messageCount,
      assign: (tenths) => {
        slot.tenths = tenths;
      },
    })),
    total - displayedTotal,
    total,
    precision
  );
  const listGate = gateShareList(
    slots.map((slot) => slot.tenths),
    othersTenths
  );
  if (listGate.isErr()) return err(listGate.error);

  // Deltas compare the SAME displayed set (current tops) against the prior
  // equal-length window's apportioned shares; an empty prior window yields
  // null (no baseline).
  const { priorRows } = raw;
  const priorTotal = priorRows?.reduce((sum, row) => sum + row.messageCount, 0) ?? 0;
  let priorOthersTenths: number | null = null;
  if (priorRows !== null && priorTotal > 0) {
    const priorPrecision: Precision = priorTotal < WHOLE_PERCENT_MIN_SAMPLE ? 'whole' : 'tenth';
    const priorCounts = slots.map((slot) => ({
      slot,
      count: priorRows.find((row) => row.modelId === slot.row.modelId)?.messageCount ?? 0,
    }));
    const priorDisplayedTotal = priorCounts.reduce((sum, entry) => sum + entry.count, 0);
    priorOthersTenths = apportionShareTenths(
      priorCounts.map((entry) => ({
        key: entry.slot.row.modelId,
        count: entry.count,
        assign: (tenths) => {
          entry.slot.priorTenths = tenths;
        },
      })),
      priorTotal - priorDisplayedTotal,
      priorTotal,
      priorPrecision
    );
  }

  const ordered = slots.toSorted(
    (a, b) => b.tenths - a.tenths || a.row.modelId.localeCompare(b.row.modelId)
  );
  const models = ordered.map(({ row, tenths, priorTenths }) => {
    const modelMeta = meta.get(row.modelId);
    return {
      modelId: row.modelId,
      displayName: modelMeta?.displayName ?? row.modelId,
      provider: modelMeta?.provider ?? row.modelId,
      sharePercent: tenths / 10,
      deltaPoints: priorTenths === null ? null : (tenths - priorTenths) / 10,
      avgCostUsd: nanoUsdToUsdString(roundHalfEvenDiv(row.costNanoUsd, BigInt(row.messageCount))),
    };
  });
  const othersDelta = priorOthersTenths === null ? null : (othersTenths - priorOthersTenths) / 10;

  const cost = buildCost(raw.rows, raw.percentiles, total);
  if (cost.isErr()) return err(cost.error);
  const trend = buildTrend(
    raw,
    ordered.map((slot) => slot.row),
    precision,
    now
  );
  if (trend.isErr()) return err(trend.error);

  return ok({
    models,
    others: { sharePercent: othersTenths / 10, deltaPoints: othersDelta },
    trend: trend.value,
    cost: cost.value,
  });
}

/** The four store reads for one (modality, window); null = no records, omit it. */
async function collectWindow(
  deps: BuildPublicUsageStatsDeps,
  modality: Modality,
  window: UsageStatsWindow
): Promise<Result<RawWindowData | null, DomainError>> {
  const end = deps.now;
  const start = window.days === null ? null : new Date(end.getTime() - window.days * DAY_MS);
  const query = { modality, start, end };

  const rowsResult = await deps.stores.aggregateGlobalUsageByModel(deps.db, query);
  if (rowsResult.isErr()) return err(rowsResult.error);
  if (rowsResult.value.length === 0) return ok(null);

  const percentilesResult = await deps.stores.readGlobalCostPercentiles(deps.db, query);
  if (percentilesResult.isErr()) return err(percentilesResult.error);

  const trendResult = await deps.stores.readGlobalTrendCounts(deps.db, {
    ...query,
    bucket: window.trendBucket,
  });
  if (trendResult.isErr()) return err(trendResult.error);

  let priorRows: readonly GlobalModelUsageRow[] | null = null;
  if (window.hasDelta && window.days !== null && start !== null) {
    const priorResult = await deps.stores.aggregateGlobalUsageByModel(deps.db, {
      modality,
      start: new Date(start.getTime() - window.days * DAY_MS),
      end: start,
    });
    if (priorResult.isErr()) return err(priorResult.error);
    priorRows = priorResult.value;
  }

  return ok({
    window,
    rows: rowsResult.value,
    percentiles: percentilesResult.value,
    trendRows: trendResult.value,
    priorRows,
  });
}

async function collectRaw(
  deps: BuildPublicUsageStatsDeps
): Promise<Result<ReadonlyMap<Modality, readonly RawWindowData[]>, DomainError>> {
  const rawByModality = new Map<Modality, RawWindowData[]>();
  for (const modality of MODALITIES) {
    for (const window of USAGE_STATS_WINDOWS) {
      const collected = await collectWindow(deps, modality, window);
      if (collected.isErr()) return err(collected.error);
      if (collected.value === null) continue;
      const list = rawByModality.get(modality) ?? [];
      list.push(collected.value);
      rawByModality.set(modality, list);
    }
  }
  return ok(rawByModality);
}

/** The union of displayed model ids — the only ids whose meta is needed. */
function collectDisplayedIds(
  rawByModality: ReadonlyMap<Modality, readonly RawWindowData[]>
): readonly string[] {
  const ids = new Set<string>();
  for (const windows of rawByModality.values()) {
    for (const raw of windows) {
      const { total } = windowTotals(raw.rows);
      for (const model of displayedModels(raw.rows, total)) {
        ids.add(model.modelId);
      }
    }
  }
  return [...ids].toSorted((a, b) => a.localeCompare(b));
}

function assembleModalities(
  rawByModality: ReadonlyMap<Modality, readonly RawWindowData[]>,
  meta: ReadonlyMap<string, PublicStatsModelMeta>,
  now: Date
): Result<PublicUsageStats['modalities'], DomainError> {
  const modalities: PublicUsageStats['modalities'] = {};
  for (const [modality, windows] of rawByModality) {
    const record: Partial<Record<UsageStatsWindow['key'], UsageStatsWindowStats>> = {};
    for (const raw of windows) {
      const assembled = assembleWindow(raw, meta, now);
      if (assembled.isErr()) return err(assembled.error);
      record[raw.window.key] = assembled.value;
    }
    modalities[modality] = record;
  }
  return ok(modalities);
}

async function collectAndAssemble(
  deps: BuildPublicUsageStatsDeps
): Promise<Result<PublicUsageStats, DomainError>> {
  const rawResult = await collectRaw(deps);
  if (rawResult.isErr()) return err(rawResult.error);

  const metaResult = await deps.resolveModelMeta(collectDisplayedIds(rawResult.value));
  if (metaResult.isErr()) return err(metaResult.error);

  const modalitiesResult = assembleModalities(rawResult.value, metaResult.value, deps.now);
  if (modalitiesResult.isErr()) return err(modalitiesResult.error);

  const candidate: PublicUsageStats = {
    schemaVersion: PUBLIC_USAGE_STATS_SCHEMA_VERSION,
    generatedAt: deps.now.toISOString(),
    modalities: modalitiesResult.value,
  };
  // The last write-gate: the strict schema rejects any count-like field, so a
  // payload that leaves this function is structurally anonymized.
  const parsed = publicUsageStatsSchema.safeParse(candidate);
  if (!parsed.success) return err(invariant('payload failed the schema write-gate'));
  return ok(parsed.data);
}

/**
 * Builds the full anonymized public usage-stats payload from global
 * usage_records aggregates. Counts die inside this function — the returned
 * object carries only shares, deltas, and cost strings.
 */
export function buildPublicUsageStats(
  deps: BuildPublicUsageStatsDeps
): ResultAsync<PublicUsageStats, DomainError> {
  // fromSafePromise: collectAndAssemble routes every store/meta failure
  // through Result; a throw from an injected dep would be a defect by
  // doctrine, not an expected failure — its promise cannot reject.
  return ResultAsync.fromSafePromise(collectAndAssemble(deps)).andThen((result) => result);
}

/**
 * Persists one snapshot row after re-running the schema write-gate. The cron
 * invokes this at-least-once; duplicate rows for the same day are harmless by
 * design — the endpoint reads only the latest row — so no dedup mechanism
 * exists.
 */
export function savePublicStatsSnapshot(
  stores: PublicStatsStores,
  db: Database,
  stats: PublicUsageStats
): ResultAsync<PublicStatsSnapshotRow, DomainError> {
  const parsed = publicUsageStatsSchema.safeParse(stats);
  if (!parsed.success) {
    return errAsync(invariant('snapshot payload failed the schema write-gate'));
  }
  return stores.insertPublicStatsSnapshot(db, {
    schemaVersion: parsed.data.schemaVersion,
    stats: parsed.data,
  });
}

/** The newest snapshot matching `schemaVersion`, or null when none exists. */
export function readLatestPublicStatsSnapshot(
  stores: PublicStatsStores,
  db: Database,
  schemaVersion: number
): ResultAsync<PublicStatsSnapshotRow | null, DomainError> {
  return stores.readLatestPublicStatsSnapshot(db, schemaVersion);
}
