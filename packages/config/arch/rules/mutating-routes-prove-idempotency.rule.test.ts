import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './mutating-routes-prove-idempotency.rule.js';

function projectWith(filePath: string, source: string): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(filePath, source);
  return project;
}

const ROUTES_PATH = 'apps/api/src/slices/billing/routes.ts';

describe('mutating-routes-prove-idempotency', () => {
  it('accepts a POST whose inline handler calls runMutation', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.post('/things', routeClass('session'), (c) =>
        runMutation(() => idempotent.byKey({ execute }))
      );\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a POST whose inline handler references idempotent.* without a literal runMutation', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.post('/things', routeClass('session'), (c) =>
        wrap(idempotent.byUpsert(() => create(c)))
      );\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a non-exempt POST whose handler performs a bare DB write with no wrapper', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.post('/things', routeClass('session'), async (c) => {
        await db.insert(things).values(c.req.valid('json'));
        return c.json({ ok: true });
      });\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: ROUTES_PATH, line: 1 });
    expect(violations[0]?.message).toMatch(/runMutation/);
  });

  it('flags a non-exempt PUT with no wrapper', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.put('/things/:id', routeClass('session'), (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a non-exempt PATCH with no wrapper', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.patch('/things/:id', routeClass('session'), (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a non-exempt DELETE with no wrapper', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.delete('/things/:id', routeClass('session'), (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('ignores GET routes', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.get('/things', routeClass('session'), (c) => c.json({ things: [] }));\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('skips a directly declared-exempt mutating route (the exemption rule proves its wrapper)', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.post('/webhooks/helcim', idempotencyExempt('webhook-event-id'), (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('skips a mutating route covered by a subtree exemption declaration', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.use('/webhooks/*', idempotencyExempt('webhook-event-id'));
      app.post('/webhooks/helcim', (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('still flags a non-exempt route outside a subtree exemption prefix', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.use('/webhooks/*', idempotencyExempt('webhook-event-id'));
      app.post('/things', (c) => c.json({ ok: true }));\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ line: 2 });
  });

  it('accepts a handler that routes through a same-file wrapper helper', () => {
    const project = projectWith(
      ROUTES_PATH,
      `function runByKey(route) {
        return runMutation(() => idempotent.byKey(route));
      }
      app.post('/', routeClass('session'), async (c) => {
        const result = await runByKey({ c, body: c.req.valid('json'), execute });
        return respond200(c, result);
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a run-initiating handler that routes through the ConversationRoom startRun seam', () => {
    const project = projectWith(
      'apps/api/src/slices/chat/routes.ts',
      `app.post('/', routeClass('session'), async (c) => {
        const runKey = requiredRunKey(c);
        return respondRunStart(c, deps.realtime(c.env).startRun(body.conversationId, runStartBody));
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a stop handler that routes through the stopRun seam', () => {
    const project = projectWith(
      'apps/api/src/slices/chat/routes.ts',
      `app.post('/stop', routeClass('session'), async (c) => {
        const stopped = await deps.realtime(c.env).stopRun(conversationId);
        return stopped.match(onOk, onErr);
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a resolved same-file named handler that wraps', () => {
    const project = projectWith(
      ROUTES_PATH,
      `const handleThing = (c) => runMutation(() => idempotent.byKey({ execute }));
      app.post('/things', routeClass('session'), handleThing);\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a mutating route whose handler is imported from another file (unprovable)', () => {
    const project = projectWith(
      ROUTES_PATH,
      `import { handleThing } from './handlers.js';
      app.post('/things', routeClass('session'), handleThing);\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/another file/);
  });

  it('ignores test files', () => {
    const project = projectWith(
      'apps/api/src/slices/billing/routes.test.ts',
      `app.post('/things', routeClass('session'), (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores files outside the api source tree', () => {
    const project = projectWith(
      'packages/shared/src/notes.ts',
      `app.post('/things', routeClass('session'), (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toEqual([]);
  });
});
