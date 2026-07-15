// Programmatic ESLint tests for the accessibility config-wrapper selectors (F42):
//   1. raw `<img>` ban                              (reactConfig, no-restricted-syntax)
//   2. inline color/font style                      (reactConfig, no-restricted-syntax)
//   3. requestAnimationFrame bare-name ban          (createBaseConfig, no-restricted-globals)
//   4. window/globalThis.requestAnimationFrame ban  (reactConfig, no-restricted-syntax)
//
// The real, exported production config objects are applied to fixture code, so
// a selector that stops firing (or starts firing where it shouldn't) fails here
// instead of silently shipping. The assertions count messages by `ruleId` only
// and never inspect message text, so they guarantee firing behavior — not the
// wording of any message; a message-only edit is not caught here. Nothing is
// copied: reactConfig is applied whole, and the bare-name rAF rule value is
// pulled out of createBaseConfig's own output at runtime — there is no second
// source of truth to drift from eslint.config.js.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';
import { createBaseConfig, reactConfig } from '../eslint.config.js';

const cwd = path.dirname(fileURLToPath(import.meta.url));

// reactConfig's inline color/font + raw-img bans are defined for `src/**/*.tsx`,
// so fixtures are linted under a synthetic `src/` path.
const reactLinter = new ESLint({
  cwd,
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ['**/*.tsx'],
      languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    },
    ...reactConfig,
  ],
});

async function restrictedSyntaxCount(code) {
  const [result] = await reactLinter.lintText(code, {
    filePath: path.join(cwd, 'src', 'fixture.tsx'),
  });
  return result.messages.filter((message) => message.ruleId === 'no-restricted-syntax').length;
}

// The rAF ban is a `no-restricted-globals` entry inside createBaseConfig. Pull
// its exact value from the real config rather than re-declaring it, then apply
// it in isolation (createBaseConfig as a whole pulls in type-aware parsing that
// needs a real TS project — irrelevant to this syntactic global check).
let globalsLinter;

beforeAll(() => {
  const base = createBaseConfig(cwd);
  const noRestrictedGlobals = base
    .map((entry) => entry.rules?.['no-restricted-globals'])
    .find((value) => value !== undefined);
  if (noRestrictedGlobals === undefined) {
    throw new Error('createBaseConfig no longer defines no-restricted-globals');
  }
  globalsLinter = new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        rules: { 'no-restricted-globals': noRestrictedGlobals },
      },
    ],
  });
});

async function restrictedGlobalsCount(code) {
  const [result] = await globalsLinter.lintText(code, { filePath: path.join(cwd, 'fixture.ts') });
  return result.messages.filter((message) => message.ruleId === 'no-restricted-globals').length;
}

describe('a11y selector: raw <img> ban', () => {
  it('flags a raw <img> element', async () => {
    expect(
      await restrictedSyntaxCount('export const A = () => <img src="x" alt="y" />;\n')
    ).toBeGreaterThan(0);
  });

  it('passes the <Img> wrapper', async () => {
    expect(await restrictedSyntaxCount('export const A = () => <Img src="x" alt="y" />;\n')).toBe(
      0
    );
  });

  it('passes the <Logo> wrapper', async () => {
    expect(await restrictedSyntaxCount('export const A = () => <Logo />;\n')).toBe(0);
  });
});

describe('a11y selector: inline color/font style props', () => {
  it('flags an inline `color` style prop', async () => {
    expect(
      await restrictedSyntaxCount('export const A = () => <div style={{ color: "red" }} />;\n')
    ).toBeGreaterThan(0);
  });

  it('flags an inline `fontSize` style prop', async () => {
    expect(
      await restrictedSyntaxCount('export const A = () => <div style={{ fontSize: 14 }} />;\n')
    ).toBeGreaterThan(0);
  });

  it('passes a className-based equivalent', async () => {
    expect(
      await restrictedSyntaxCount(
        'export const A = () => <div className="text-destructive text-sm" />;\n'
      )
    ).toBe(0);
  });
});

describe('a11y selector: requestAnimationFrame ban', () => {
  it('flags a bare requestAnimationFrame call', async () => {
    expect(
      await restrictedGlobalsCount('const id = requestAnimationFrame(tick);\n')
    ).toBeGreaterThan(0);
  });

  it('passes the useAnimationFrame hook', async () => {
    expect(await restrictedGlobalsCount('const id = useAnimationFrame(tick);\n')).toBe(0);
  });

  it('flags window.requestAnimationFrame (member-expression form)', async () => {
    expect(
      await restrictedSyntaxCount('export const A = () => window.requestAnimationFrame(tick);\n')
    ).toBeGreaterThan(0);
  });

  it('flags globalThis.requestAnimationFrame (member-expression form)', async () => {
    expect(
      await restrictedSyntaxCount(
        'export const A = () => globalThis.requestAnimationFrame(tick);\n'
      )
    ).toBeGreaterThan(0);
  });

  it('passes the useAnimationFrame hook against the member-expression selector', async () => {
    expect(await restrictedSyntaxCount('export const A = () => useAnimationFrame(tick);\n')).toBe(
      0
    );
  });
});
