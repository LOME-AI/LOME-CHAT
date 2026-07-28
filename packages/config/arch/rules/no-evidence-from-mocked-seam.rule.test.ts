import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './no-evidence-from-mocked-seam.rule.js';

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

const ADAPTER_TEST = 'apps/api/src/slices/notifications/adapters/push-fcm.integration.test.ts';

describe('no-evidence-from-mocked-seam', () => {
  it('flags a mocked fetch handed to an adapter alongside a hardcoded isCI: true', () => {
    const project = projectWith({
      [ADAPTER_TEST]: [
        "import { vi } from 'vitest';",
        'let fetchImpl;',
        'beforeAll(() => {',
        '  fetchImpl = vi.fn();',
        '});',
        "it('lands an evidence row', async () => {",
        "  const sender = createFcmPushSender({ projectId: 'p', fetchImpl, db, isCI: true });",
        '  await sender.send(message);',
        '});',
      ].join('\n'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: `/${ADAPTER_TEST}`, line: 7 });
    expect(violations[0]?.message).toContain('line 7');
    expect(violations[0]?.message).toContain('evidence');
  });

  it('flags a mocked fetch built by a local helper alongside a hardcoded isCI: true', () => {
    const project = projectWith({
      'apps/api/src/slices/notifications/adapters/email-resend.integration.test.ts': [
        "import { vi } from 'vitest';",
        'function okFetch(id) {',
        '  return vi.fn(() => Promise.resolve(Response.json({ id })));',
        '}',
        "it('writes evidence', async () => {",
        '  const sender = createResendEmailSender({',
        "    apiKey: 'k',",
        '    db,',
        '    isCI: true,',
        "    fetchImpl: okFetch('a'),",
        '  });',
        '  await sender.send(message);',
        '});',
      ].join('\n'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(9);
  });

  it('flags a mocked fetch cast to the fetch type alongside a hardcoded isCI: true', () => {
    const project = projectWith({
      [ADAPTER_TEST]: [
        "import { vi } from 'vitest';",
        'const mockTransport = vi.fn();',
        'const sender = make({ fetchImpl: mockTransport as typeof fetch, isCI: true });',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a mocked fetch written inline into the adapter options', () => {
    const project = projectWith({
      [ADAPTER_TEST]: [
        "import { vi } from 'vitest';",
        'const sender = make({ fetchImpl: vi.fn(), isCI: true });',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a file that records evidence directly while passing a mocked fetch', () => {
    const project = projectWith({
      [ADAPTER_TEST]: [
        "import { vi } from 'vitest';",
        'const fetchImpl = vi.fn();',
        "it('records', async () => {",
        '  await make({ fetchImpl }).send(message);',
        '  await recordServiceEvidence(db, isCI, SERVICE_NAMES.PUSH_FCM);',
        '});',
      ].join('\n'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(5);
  });

  it('flags a file that records evidence while stubbing the global fetch', () => {
    const project = projectWith({
      [ADAPTER_TEST]: [
        "import { vi } from 'vitest';",
        "vi.stubGlobal('fetch', vi.fn());",
        'await recordServiceEvidence(db, isCI, SERVICE_NAMES.R2_STORAGE);',
      ].join('\n'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('passes a fetch wrapper that delegates to the real global fetch and records evidence', () => {
    const project = projectWith({
      'apps/api/src/slices/notifications/adapters/push-fcm-live.integration.test.ts': [
        "import { describe, expect, it } from 'vitest';",
        "it('reaches the real service', async () => {",
        '  const capturingFetch: typeof fetch = async (input, init) => {',
        '    const response = await fetch(input, init);',
        '    legs.push(await response.clone().json());',
        '    return response;',
        '  };',
        '  const sender = createFcmPushSender({',
        '    projectId,',
        '    fetchImpl: capturingFetch,',
        '    validateOnly: true,',
        '  });',
        '  await sender.send(message);',
        '  await recordServiceEvidence(db, AMBIENT_ENV.isCI, SERVICE_NAMES.PUSH_FCM, {});',
        '});',
      ].join('\n'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes an inline wrapper that delegates to the real global fetch', () => {
    const project = projectWith({
      [ADAPTER_TEST]: [
        'const sender = make({ fetchImpl: async (input) => fetch(input), isCI: true });',
        'await recordServiceEvidence(db, isCI, SERVICE_NAMES.PUSH_FCM);',
      ].join('\n'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a first-party cassette transport holding the real global fetch', () => {
    const project = projectWith({
      'apps/api/src/slices/models/domain/gateway-metadata.integration.test.ts': [
        'const cassetteFetch = createCassetteFetch({',
        '  realFetch: globalThis.fetch.bind(globalThis),',
        '});',
        'const result = await fetchGatewayCatalog({ baseUrl, fetch: cassetteFetch });',
        'await recordServiceEvidence(db, envUtilities.isCI, SERVICE_NAMES.OPENROUTER);',
      ].join('\n'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a mocked fetch when the file enables no evidence write', () => {
    const project = projectWith({
      'apps/api/src/slices/media/adapters/storage-r2.test.ts': [
        "import { vi } from 'vitest';",
        'const fetchMock = vi.fn();',
        'let sender;',
        'beforeEach(() => {',
        '  vi.clearAllMocks();',
        "  handlers['fetch'] = vi.fn();",
        "  vi.stubGlobal('fetch', fetchMock);",
        '  sender = make({ fetchImpl: fetchMock, isCI: false });',
        '});',
      ].join('\n'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a hardcoded isCI: true when the transport is not faked', () => {
    const project = projectWith({
      'apps/api/src/slices/models/adapters/resolve-model-provider.test.ts': [
        "import { vi } from 'vitest';",
        'const insert = vi.fn(() => ({ values: vi.fn() }));',
        "const provider = resolveModelProvider({ useMock: false, apiKey: 'k', isCI: true, db });",
        'expect(provider.fetch).toBeUndefined();',
      ].join('\n'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a production adapter that records evidence with no test doubles', () => {
    const project = projectWith({
      'apps/api/src/slices/billing/adapters/payment-helcim.ts': [
        'export function createHelcimProvider(config) {',
        '  const enabled = config.isCI && config.db !== undefined;',
        '  return {',
        '    charge: async () => {',
        '      await recordServiceEvidence(config.db, config.isCI, SERVICE_NAMES.HELCIM);',
        '    },',
        '  };',
        '}',
      ].join('\n'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores web files, which never write service evidence', () => {
    const project = projectWith({
      'apps/web/src/lib/thing.test.ts': [
        "import { vi } from 'vitest';",
        'const fetchImpl = vi.fn();',
        'await recordServiceEvidence(db, isCI, SERVICE_NAMES.PUSH_FCM);',
      ].join('\n'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reports one violation per file even when several shapes are present', () => {
    const project = projectWith({
      [ADAPTER_TEST]: [
        "import { vi } from 'vitest';",
        'const fetchImpl = vi.fn();',
        'const a = make({ fetchImpl, isCI: true });',
        'const b = make({ fetchImpl, isCI: true });',
        'await recordServiceEvidence(db, isCI, SERVICE_NAMES.PUSH_FCM);',
      ].join('\n'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(3);
  });
});
