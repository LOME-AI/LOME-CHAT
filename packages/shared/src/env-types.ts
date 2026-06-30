/** Destinations for environment variables */
export enum Destination {
  Backend = 'backend', // → .dev.vars (local) / wrangler.toml + secrets (prod)
  Frontend = 'frontend', // → .env.development (Vite, VITE_* vars only)
  Scripts = 'scripts', // → .env.scripts (migrations, seed, etc.)
  Ops = 'ops', // → ops runner env blocks only (ci.yml ops-env + run-ops-script.yml ops-dispatch-env); never wrangler secret put / runtime Worker
}

/** Environment modes */
export enum Mode {
  Development = 'development',
  CiVitest = 'ciVitest',
  E2E = 'e2e',
  CiE2E = 'ciE2E',
  Production = 'production',
}

// String union derived from enum for type compatibility
export type EnvMode = `${Mode}`;

/** Reference to another environment's value */
export interface Ref {
  readonly _type: 'ref';
  readonly env: EnvMode;
}

/** Reference to a GitHub secret */
export interface Secret {
  readonly _type: 'secret';
  readonly name: string;
}

/** A value can be literal, reference, or secret */
export type EnvValue = string | Ref | Secret;

/** Mode value: just a value (uses default `to`) or value with destination override */
export type ModeValue = EnvValue | { value: EnvValue; to: Destination[] };

/** Configuration for a single environment variable */
export interface VariableConfig {
  readonly to: Destination[]; // default destinations
  readonly [Mode.Development]?: ModeValue;
  readonly [Mode.CiVitest]?: ModeValue;
  readonly [Mode.E2E]?: ModeValue;
  readonly [Mode.CiE2E]?: ModeValue;
  readonly [Mode.Production]?: ModeValue;
}

export const ref = (env: EnvMode): Ref => ({ _type: 'ref', env });
export const secret = (name: string): Secret => ({ _type: 'secret', name });

// Type guards (use unknown for idiomatic type guards that work on any input)
export const isRef = (v: unknown): v is Ref =>
  typeof v === 'object' && v !== null && '_type' in v && v._type === 'ref';
export const isSecret = (v: unknown): v is Secret =>
  typeof v === 'object' && v !== null && '_type' in v && v._type === 'secret';
export const isModeOverride = (v: unknown): v is { value: EnvValue; to: Destination[] } =>
  typeof v === 'object' && v !== null && 'value' in v && 'to' in v;

/** Get destinations for a specific mode (uses override or default). */
export function getDestinations(config: VariableConfig, mode: EnvMode): Destination[] {
  const modeValue = config[mode];
  if (modeValue === undefined) return [];
  if (isModeOverride(modeValue)) return modeValue.to;
  if (isRef(modeValue)) return getDestinations(config, modeValue.env);
  return config.to;
}

/** Get the raw EnvValue for a mode (unwraps override object) */

export function getModeValue(config: VariableConfig, mode: EnvMode): EnvValue | undefined {
  const modeValue = config[mode];
  if (modeValue === undefined) return undefined;
  if (isModeOverride(modeValue)) return modeValue.value;
  return modeValue;
}

/** Resolve a value, following refs (returns string or Secret, never Ref) */
// eslint-disable-next-line sonarjs/function-return-type -- intentional optional return
export function resolveRaw(config: VariableConfig, mode: EnvMode): string | Secret | undefined {
  const raw = getModeValue(config, mode);
  if (raw === undefined) return undefined;
  if (isRef(raw)) return resolveRaw(config, raw.env);
  return raw;
}

/** Resolve to final string value */
export function resolveValue(
  config: VariableConfig,
  mode: EnvMode,
  getSecret: (name: string) => string
): string | null {
  const raw = resolveRaw(config, mode);
  /* istanbul ignore next -- @preserve defensive check */
  if (raw === undefined) return null;
  if (isSecret(raw)) return getSecret(raw.name);
  return raw;
}

/** Check if production value resolves to a secret */
export function isProductionSecret(config: VariableConfig): boolean {
  const raw = resolveRaw(config, Mode.Production);
  return raw !== undefined && isSecret(raw);
}
