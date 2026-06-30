// Lets the turbo-style invocation (`npx eslint .` with this package dir as
// cwd) be reproduced by hand against the shipped boundaries config; the vitest
// suite injects the same entries via overrideConfig and never reads this file.
import tseslint from 'typescript-eslint';
import boundariesExtension from '../../../eslint-extensions/boundaries.config.mjs';

export default [
  { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
  ...boundariesExtension,
];
