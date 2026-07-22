import path from 'node:path';
import { recordServiceEvidence, SERVICE_NAMES } from '@hushbox/db';
import { createModelProvider } from './dispatch.js';
import { createMockModelProvider } from './mock-provider.js';
import { createCassetteFetch } from './cassette/recording-fetch.js';
import { createCassetteStore } from './cassette/cassette-store.js';
import { cassetteModeFor } from './cassette/mode.js';
import type { CreateModelProviderOptions } from './dispatch.js';
import type { MockDirectives } from './mock-provider.js';
import type { ModelProvider } from '../ports/index.js';
import type { Database } from '@hushbox/db';
import type { InferenceEvent } from '@hushbox/shared';

/**
 * THE single source of truth for how AI inference is served. It mirrors the
 * legacy `getAIClient` three-way gate in the vertical-slice design; chat's
 * `providerFor` delegates here so no provider-selection logic lives anywhere
 * else. The three mutually-exclusive states:
 *
 *   1. dev / E2E (`useMock`)           → deterministic mock provider. NEVER
 *      records evidence, NEVER makes a real call, needs no key.
 *   2. real + CI-vitest (`!useMock && isCI`) → real provider whose SDK `fetch`
 *      is the record-on-miss HTTP cassette, wrapped so the FIRST successful
 *      inference event records `openrouter` service-evidence exactly once.
 *   3. real + production (`!useMock && !isCI`) → real provider with plain
 *      `globalThis.fetch`; no cassette, no evidence.
 */

/**
 * Filesystem root for HTTP cassettes (`../../.ai-cassettes` from the api cwd).
 * CI restores/saves this directory across runs; locally it is git-ignored.
 * Same computation as the legacy integration setup so recordings are shared.
 */
const CASSETTE_ROOT = path.resolve(process.cwd(), '../../.ai-cassettes');

/**
 * The dev/local `.dev.vars` placeholder for `OPENROUTER_API_KEY`. Recording CI
 * cassettes against it would burn a run and cache a 401 forever, so the
 * CI-vitest path refuses it explicitly — belt-and-suspenders over the composer
 * having already selected the real path from the environment.
 */
const DEV_MOCK_OPENROUTER_KEY = 'mock-openrouter-key';

interface ResolveModelProviderInput {
  /** True only when THIS run selects the deterministic mock (dev/E2E + directives). */
  readonly useMock: boolean;
  /** OpenRouter key; must be present and non-empty on any real path. */
  readonly apiKey: string;
  /** CI classification — gates cassette engagement and service-evidence recording. */
  readonly isCI: boolean;
  /** DO-scoped db for the CI-vitest evidence write; unused on the mock/production paths. */
  readonly db: Database | undefined;
  /** Per-run mock directives (dev/E2E only); ignored on the real paths. */
  readonly mockDirectives?: MockDirectives;
  /** Dev/E2E held-stream release barrier; ignored on the real paths. */
  readonly awaitStreamRelease?: () => Promise<void>;
  /**
   * Whether this is a real interactive dev server (`createEnvUtilities().isDevServer`
   * — excludes E2E, vitest, CI, production), set by the composer. Gates the mock's
   * visible streaming/media/classifier delay DEFAULTS: on only here, so automated
   * runs stay delay-free. Omitted defaults to false; per-request delay directives
   * still apply regardless. Ignored on the real paths.
   */
  readonly isDevServer?: boolean;
}

/** Test seam: injects a fake provider factory so the real paths are unit-testable without a live call. */
interface ResolveModelProviderInternals {
  readonly createProvider?: (options: CreateModelProviderOptions) => ModelProvider;
}

/**
 * Wrap a real provider so the FIRST successful inference event records
 * `openrouter` service-evidence exactly once (mirrors legacy `real.ts`). A
 * stream that errors before yielding never records; a stream that errors after
 * the first event keeps the record — evidence proves the integration ran,
 * regardless of whether the bytes came from a live call or a cassette replay.
 * The write is isCI-gated inside `recordServiceEvidence`.
 */
function withEvidenceOnFirstEvent(
  provider: ModelProvider,
  db: Database,
  isCI: boolean
): ModelProvider {
  return {
    infer(request, descriptor, options): AsyncIterable<InferenceEvent> {
      const upstream = provider.infer(request, descriptor, options);
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
          let recorded = false;
          for await (const event of upstream) {
            if (!recorded) {
              recorded = true;
              await recordServiceEvidence(db, isCI, SERVICE_NAMES.OPENROUTER);
            }
            yield event;
          }
        },
      };
    },
  };
}

export function resolveModelProvider(
  input: ResolveModelProviderInput,
  internals: ResolveModelProviderInternals = {}
): ModelProvider {
  const createProvider = internals.createProvider ?? createModelProvider;

  if (input.useMock) {
    return createMockModelProvider(
      input.mockDirectives,
      input.awaitStreamRelease,
      input.isDevServer
    );
  }

  // Real path: the key is load-bearing and must never be empty.
  if (input.apiKey === '') {
    throw new Error(
      'resolveModelProvider: real inference requires a non-empty OPENROUTER_API_KEY — the runtime fails fast instead of degrading.'
    );
  }

  if (!input.isCI) {
    // Production: plain globalThis.fetch, no cassette, no evidence.
    return createProvider({ apiKey: input.apiKey });
  }

  // CI-vitest: real provider over the record-on-miss cassette + evidence-once.
  if (input.apiKey === DEV_MOCK_OPENROUTER_KEY) {
    throw new Error(
      'resolveModelProvider: refusing to record CI cassettes against the dev mock OPENROUTER_API_KEY.'
    );
  }
  if (input.db === undefined) {
    throw new Error('resolveModelProvider: the CI-vitest path requires a db for service-evidence.');
  }

  const fetch = createCassetteFetch({
    store: createCassetteStore({ rootDir: CASSETTE_ROOT }),
    mode: cassetteModeFor(),
    realFetch: globalThis.fetch.bind(globalThis),
  });
  const provider = createProvider({ apiKey: input.apiKey, fetch });
  return withEvidenceOnFirstEvent(provider, input.db, input.isCI);
}
