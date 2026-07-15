// Programmatic ESLint tests for the no-silent-catch-swallow lint set (F20).
// The config is applied directly to fixture code with synthetic paths, so the
// rule's absolute-filename self-scoping is exercised without real files.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig from './catch-swallow.config.mjs';

const cwd = path.dirname(fileURLToPath(import.meta.url));

function createLinter() {
  return new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
      ...extensionConfig,
    ],
  });
}

async function catchMessages(code, filePath) {
  const [result] = await createLinter().lintText(code, {
    filePath: path.join(cwd, ...filePath.split('/')),
  });
  return result.messages.filter((message) => message.ruleId === 'catch-swallow/no-silent-catch');
}

const SLICE = 'apps/api/src/slices/chat/domain/turn.ts';
const LIB = 'apps/api/src/lib/result/consume.ts';
const SLICE_TEST = 'apps/api/src/slices/chat/domain/turn.test.ts';
const OTHER = 'apps/api/src/platform/health.ts';

describe('catch-swallow/no-silent-catch', () => {
  it('fails `catch { return null }` in a slice', async () => {
    const code =
      'export function f() {\n  try {\n    g();\n  } catch {\n    return null;\n  }\n}\n';

    const messages = await catchMessages(code, SLICE);

    expect(messages).toHaveLength(1);
    expect(messages[0].messageId).toBe('silentCatch');
  });

  it('fails an empty `catch {}`', async () => {
    const code = 'export function f() {\n  try {\n    g();\n  } catch {}\n}\n';

    const messages = await catchMessages(code, SLICE);

    expect(messages).toHaveLength(1);
    expect(messages[0].messageId).toBe('emptyCatch');
  });

  it('passes `catch (e) { throw e }`', async () => {
    const code =
      'export function f() {\n  try {\n    g();\n  } catch (e) {\n    throw e;\n  }\n}\n';

    expect(await catchMessages(code, SLICE)).toEqual([]);
  });

  it('passes `catch (e) { captureError(...) }`', async () => {
    const code =
      'export function f() {\n  try {\n    g();\n  } catch (e) {\n    captureError(e);\n  }\n}\n';

    expect(await catchMessages(code, SLICE)).toEqual([]);
  });

  it('passes `catch { return err(...) }`', async () => {
    const code =
      "export function f() {\n  try {\n    g();\n  } catch {\n    return err('boom');\n  }\n}\n";

    expect(await catchMessages(code, SLICE)).toEqual([]);
  });

  it('passes a catch that returns a *DomainError', async () => {
    const code =
      'export function f() {\n  try {\n    g();\n  } catch {\n    return new ChatDomainError();\n  }\n}\n';

    expect(await catchMessages(code, SLICE)).toEqual([]);
  });

  it('passes a member-form captureError call (telemetry.captureError)', async () => {
    const code =
      'export function f(t) {\n  try {\n    g();\n  } catch (e) {\n    t.captureError(e);\n  }\n}\n';

    expect(await catchMessages(code, SLICE)).toEqual([]);
  });

  it('does not treat a computed-member call as handling', async () => {
    const code =
      "export function f(obj) {\n  try {\n    g();\n  } catch {\n    obj['captureError']();\n    return null;\n  }\n}\n";

    expect(await catchMessages(code, SLICE)).toHaveLength(1);
  });

  it('flags a silent catch in the lib tree too', async () => {
    const code =
      'export function f() {\n  try {\n    g();\n  } catch {\n    return null;\n  }\n}\n';

    expect(await catchMessages(code, LIB)).toHaveLength(1);
  });

  it('does not count a throw inside a nested callback as handling the outer catch', async () => {
    const code =
      'export function f(xs) {\n  try {\n    g();\n  } catch {\n    xs.forEach(() => {\n      throw new Error();\n    });\n  }\n}\n';

    expect(await catchMessages(code, SLICE)).toHaveLength(1);
  });

  it('does not count throws in a nested function or nested catch as handling the outer catch', async () => {
    const code =
      'export function f() {\n  try {\n    g();\n  } catch {\n    function inner() {\n      throw new Error();\n    }\n    try {\n      inner();\n    } catch {\n      throw new Error();\n    }\n    return null;\n  }\n}\n';

    // The outer catch itself never throws/handles; both throws live in inner
    // frames. The inner empty-free catch does handle itself (it throws), so
    // only the outer catch is flagged.
    expect(await catchMessages(code, SLICE)).toHaveLength(1);
  });

  it('is silent in slice test files', async () => {
    const code =
      'export function f() {\n  try {\n    g();\n  } catch {\n    return null;\n  }\n}\n';

    expect(await catchMessages(code, SLICE_TEST)).toEqual([]);
  });

  it('is silent outside the slices/lib trees', async () => {
    const code = 'export function f() {\n  try {\n    g();\n  } catch {}\n}\n';

    expect(await catchMessages(code, OTHER)).toEqual([]);
  });
});
