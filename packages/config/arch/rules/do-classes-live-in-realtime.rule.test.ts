import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './do-classes-live-in-realtime.rule.js';

function projectWith(filePath: string, source: string): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(filePath, source);
  return project;
}

describe('do-classes-live-in-realtime', () => {
  it('flags a class extending DurableObject declared inside a slice', () => {
    const project = projectWith(
      'apps/api/src/slices/chat/room.ts',
      'export class ChatRoom extends DurableObject {}\n'
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: 'apps/api/src/slices/chat/room.ts', line: 1 });
  });

  it('flags a generic DurableObject subclass inside a slice', () => {
    const project = projectWith(
      'apps/api/src/slices/chat/room.ts',
      'export class ChatRoom extends DurableObject<Env> {}\n'
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a subclass extending DurableObject through a named-import alias', () => {
    const project = projectWith(
      'apps/api/src/slices/chat/room.ts',
      "import { DurableObject as DO } from 'cloudflare:workers';\nexport class ChatRoom extends DO {}\n"
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a subclass extending DurableObject through a namespace import', () => {
    const project = projectWith(
      'apps/api/src/slices/chat/room.ts',
      "import * as workers from 'cloudflare:workers';\nexport class ChatRoom extends workers.DurableObject {}\n"
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a subclass extending DurableObject through a local variable alias', () => {
    const project = projectWith(
      'apps/api/src/slices/chat/room.ts',
      "import { DurableObject } from 'cloudflare:workers';\nconst Base = DurableObject;\nexport class ChatRoom extends Base {}\n"
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('follows a chain of local aliases to DurableObject', () => {
    const project = projectWith(
      'apps/api/src/slices/chat/room.ts',
      'let helper;\nconst A = DurableObject;\nconst B = A;\nexport class ChatRoom extends B {}\n'
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('follows a namespace-member variable alias to DurableObject', () => {
    const project = projectWith(
      'apps/api/src/slices/chat/room.ts',
      "import * as workers from 'cloudflare:workers';\nconst Base = workers.DurableObject;\nexport class ChatRoom extends Base {}\n"
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('skips variable initializers that are not DurableObject aliases', () => {
    const project = projectWith(
      'apps/api/src/slices/chat/room.ts',
      'const unrelated = makeRoom();\nconst decoy = unknownName;\nexport class ChatRoom extends unrelated {}\n'
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('allows an aliased import of a different class even when the alias looks suspicious', () => {
    const project = projectWith(
      'apps/api/src/slices/chat/room.ts',
      "import { WorkerEntrypoint as DO } from 'cloudflare:workers';\nexport class ChatRoom extends DO {}\n"
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('allows a DurableObject subclass outside the slices tree', () => {
    const project = projectWith(
      'packages/realtime/src/conversation-room.ts',
      'export class ConversationRoom extends DurableObject {}\n'
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('allows ordinary classes inside a slice', () => {
    const project = projectWith(
      'apps/api/src/slices/chat/service.ts',
      'export class TurnPlanner {}\n'
    );

    expect(rule.check(project)).toEqual([]);
  });
});
