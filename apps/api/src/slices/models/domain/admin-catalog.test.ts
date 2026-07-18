import { describe, expect, it } from 'vitest';
import { ADMIN_CATALOG_MODEL_CAP, projectAdminCatalog } from './admin-catalog.js';
import type { StoredDescriptorRow } from './catalog-store.js';

/** A valid persisted wire-form descriptor (language call shape). */
function descriptorOf(modelId: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    id: modelId,
    provider: 'admin-catalog-test',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: ['streaming'],
    limits: {},
    pricing: { inputPerToken: '2500' },
    zdrReachable: true,
    name: 'Test Model',
    releasedAt: 1_700_000_000,
    fetchedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function storedRow(
  modelId: string,
  overrides: Partial<StoredDescriptorRow> = {}
): [string, StoredDescriptorRow] {
  return [
    modelId,
    {
      catalogId: crypto.randomUUID(),
      descriptor: descriptorOf(modelId),
      adminDisabledAt: null,
      popularityRank: null,
      ...overrides,
    },
  ];
}

describe('projectAdminCatalog', () => {
  it('projects identity and status from a valid descriptor and nothing else', () => {
    const page = projectAdminCatalog(new Map([storedRow('prov/alpha')]));
    expect(page.models).toEqual([
      {
        modelId: 'prov/alpha',
        name: 'Test Model',
        family: 'language',
        zdrReachable: true,
        adminDisabledAt: null,
      },
    ]);
    expect(page.truncated).toBe(false);
  });

  it('includes a disabled model with its adminDisabledAt timestamp', () => {
    const disabledAt = new Date('2026-07-13T12:00:00.000Z');
    const page = projectAdminCatalog(
      new Map([storedRow('prov/dead', { adminDisabledAt: disabledAt })])
    );
    expect(page.models[0]?.adminDisabledAt).toEqual(disabledAt);
  });

  it('includes an unexposed (ZDR-unreachable) model with its status', () => {
    const page = projectAdminCatalog(
      new Map([
        storedRow('prov/hidden', {
          descriptor: descriptorOf('prov/hidden', { zdrReachable: false }),
        }),
      ])
    );
    expect(page.models[0]?.zdrReachable).toBe(false);
  });

  it('projects a descriptor without a name as null', () => {
    const descriptor = descriptorOf('prov/nameless') as Record<string, unknown>;
    delete descriptor['name'];
    const page = projectAdminCatalog(new Map([storedRow('prov/nameless', { descriptor })]));
    expect(page.models[0]?.name).toBeNull();
  });

  it('keeps a row whose stored descriptor fails the contract, with null projections', () => {
    const disabledAt = new Date('2026-07-13T12:00:00.000Z');
    const page = projectAdminCatalog(
      new Map([
        storedRow('prov/corrupt', { descriptor: { junk: true }, adminDisabledAt: disabledAt }),
      ])
    );
    expect(page.models).toEqual([
      {
        modelId: 'prov/corrupt',
        name: null,
        family: null,
        zdrReachable: null,
        adminDisabledAt: disabledAt,
      },
    ]);
  });

  it('nulls the family when a valid descriptor has no dispatchable output', () => {
    // outputs: ['audio'] parses (a valid Modality) but classifies to no
    // call-shape family, so dispatchFamilyFor returns undefined → null.
    const page = projectAdminCatalog(
      new Map([
        storedRow('prov/audio', { descriptor: descriptorOf('prov/audio', { outputs: ['audio'] }) }),
      ])
    );
    expect(page.models[0]).toEqual({
      modelId: 'prov/audio',
      name: 'Test Model',
      family: null,
      zdrReachable: true,
      adminDisabledAt: null,
    });
  });

  it('orders deterministically by model id', () => {
    const page = projectAdminCatalog(
      new Map([storedRow('prov/zeta'), storedRow('prov/alpha'), storedRow('prov/mid')])
    );
    expect(page.models.map((model) => model.modelId)).toEqual([
      'prov/alpha',
      'prov/mid',
      'prov/zeta',
    ]);
  });

  it('caps the page at ADMIN_CATALOG_MODEL_CAP and flags truncation', () => {
    const rows = new Map(
      Array.from({ length: ADMIN_CATALOG_MODEL_CAP + 1 }, (_, index) =>
        storedRow(`prov/model-${String(index).padStart(5, '0')}`)
      )
    );
    const page = projectAdminCatalog(rows);
    expect(page.models).toHaveLength(ADMIN_CATALOG_MODEL_CAP);
    expect(page.truncated).toBe(true);
  });
});
