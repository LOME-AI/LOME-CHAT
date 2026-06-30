import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './idempotency-exemption-wrappers.rule.js';

function projectWith(filePath: string, source: string): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(filePath, source);
  return project;
}

const ROUTES_PATH = 'apps/api/src/slices/billing/routes.ts';

describe('idempotency-exemption-wrappers', () => {
  it('accepts an exempted route whose inline handler uses the matching wrapper', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.post('/webhooks/helcim', idempotencyExempt('webhook-event-id'), (c) =>
        idempotent.byEventId({ claim, execute, onDuplicate })
      );\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags an exempted route whose handler uses no wrapper', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.post('/webhooks/helcim', idempotencyExempt('webhook-event-id'), (c) =>
        c.json({ ok: true })
      );\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: ROUTES_PATH, line: 1 });
    expect(violations[0]?.message).toMatch(/byEventId/);
  });

  it('flags an exempted route whose handler uses a non-matching wrapper', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.post('/webhooks/helcim', idempotencyExempt('webhook-event-id'), (c) =>
        idempotent.byUpsert(() => create(c))
      );\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts either allowed wrapper for a class that names two', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.post('/logout', idempotencyExempt('naturally-idempotent'), (c) =>
        idempotent.byTransition({ transition, onZeroRows })
      );
      app.post('/decline', idempotencyExempt('naturally-idempotent'), (c) =>
        idempotent.byUpsert(() => decline(c))
      );\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags an unknown exemption class', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.post('/x', idempotencyExempt('not-a-class'), (c) => idempotent.byEventId({}));\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/unknown exemption class/i);
  });

  it('flags a declaration without a class argument', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.post('/x', idempotencyExempt(), (c) => idempotent.byEventId({}));\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/\(none\)/);
  });

  it('flags a declaration outside a route registration', () => {
    const project = projectWith(
      ROUTES_PATH,
      `const marker = idempotencyExempt('webhook-event-id');\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/route registration/);
  });

  it('flags a declaration invoked directly instead of registered', () => {
    const project = projectWith(
      ROUTES_PATH,
      `const result = idempotencyExempt('webhook-event-id')(c, next);\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/route registration/);
  });

  it('flags a declaration passed to a bare function call', () => {
    const project = projectWith(ROUTES_PATH, `wrap(idempotencyExempt('webhook-event-id'));\n`);

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/route registration/);
  });

  it('flags a declaration on a non-registration member call', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.get('/x', idempotencyExempt('webhook-event-id'), (c) => c.json({ ok: true }));\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/route registration/);
  });

  it('resolves a same-file named handler and accepts its wrapper use', () => {
    const project = projectWith(
      ROUTES_PATH,
      `const handleWebhook = (c) => idempotent.byEventId({ claim, execute, onDuplicate });
      app.post('/webhooks/helcim', idempotencyExempt('webhook-event-id'), handleWebhook);\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('resolves a same-file function-declaration handler', () => {
    const project = projectWith(
      ROUTES_PATH,
      `function handleWebhook(c) {
        return idempotent.byEventId({ claim, execute, onDuplicate });
      }
      app.post('/webhooks/helcim', idempotencyExempt('webhook-event-id'), handleWebhook);\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a handler it cannot resolve within the file', () => {
    const project = projectWith(
      ROUTES_PATH,
      `import { handleWebhook } from './handlers.js';
      app.post('/webhooks/helcim', idempotencyExempt('webhook-event-id'), handleWebhook);\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/same file/);
  });

  it('accepts a subtree declaration whose covered routes use the allowed wrapper', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.use('/webhooks/*', idempotencyExempt('webhook-event-id'));
      app.post('/webhooks/helcim', (c) => idempotent.byEventId({ claim, execute, onDuplicate }));
      app.post('/things', (c) => c.json({ ok: true }));
      app.route('/other', otherRoutes);\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a starless subtree path covering the exact route', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.use('/webhooks', idempotencyExempt('webhook-event-id'));
      app.post('/webhooks', (c) => idempotent.byEventId({ claim, execute, onDuplicate }));\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a covered route whose handler lacks the wrapper', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.use('/webhooks/*', idempotencyExempt('webhook-event-id'));
      app.post('/webhooks/helcim', (c) => c.json({ ok: true }));\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: ROUTES_PATH, line: 2 });
    expect(violations[0]?.message).toMatch(/byEventId/);
  });

  it('flags a covered on-registration whose handler lacks the wrapper', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.use('/webhooks/*', idempotencyExempt('webhook-event-id'));
      app.on('POST', '/webhooks/helcim', (c) => c.json({ ok: true }));\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: ROUTES_PATH, line: 2 });
  });

  it('resolves a same-file named handler for a covered route', () => {
    const project = projectWith(
      ROUTES_PATH,
      `const handleWebhook = (c) => idempotent.byEventId({ claim, execute, onDuplicate });
      app.use('/webhooks/*', idempotencyExempt('webhook-event-id'));
      app.post('/webhooks/helcim', handleWebhook);\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a covered route whose handler lives in another file', () => {
    const project = projectWith(
      ROUTES_PATH,
      `import { handleWebhook } from './handlers.js';
      app.use('/webhooks/*', idempotencyExempt('webhook-event-id'));
      app.post('/webhooks/helcim', handleWebhook);\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/same file/);
  });

  it('flags a subtree declaration covering no same-file routes', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.use('/webhooks/*', idempotencyExempt('webhook-event-id'));
      app.post(dynamicPath, (c) => c.json({ ok: true }));\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/covers no/);
  });

  it('flags a subtree declaration without a literal path', () => {
    const project = projectWith(ROUTES_PATH, `app.use(idempotencyExempt('webhook-event-id'));\n`);

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/literal path/);
  });

  it('flags a sub-app mount overlapping an exempted subtree', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.use('/webhooks/*', idempotencyExempt('webhook-event-id'));
      app.post('/webhooks/helcim', (c) => idempotent.byEventId({ claim, execute, onDuplicate }));
      app.route('/webhooks', helcimRoutes);\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/mount/);
  });

  it('ignores routes without an exemption declaration', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.post('/things', routeClass('session'), (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores test files', () => {
    const project = projectWith(
      'apps/api/src/lib/idempotency/middleware.test.ts',
      `app.post('/exempted', idempotencyExempt('opaque-protocol'), (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores files outside the api source tree', () => {
    const project = projectWith(
      'packages/shared/src/notes.ts',
      `app.post('/x', idempotencyExempt('opaque-protocol'), (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toEqual([]);
  });
});
