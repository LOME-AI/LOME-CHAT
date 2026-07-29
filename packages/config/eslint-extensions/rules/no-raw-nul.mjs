/**
 * Bans the raw NUL byte (U+0000) anywhere in source text.
 *
 * A single raw NUL makes every heuristic text tool classify the whole file as
 * BINARY and skip it. The repo's `grep` is `ugrep`, which does exactly that:
 * no match, no warning, exit 0 — so a repo-wide sweep reports zero hits for a
 * symbol the file contains, and the reader has no way to tell that answer from
 * a true negative. Two source files carried one, and one of them was the
 * `apps/web` money adapter hook, so the sweeps most likely to need it were the
 * ones it was invisible to.
 *
 * The remedy is spelling, not semantics: the escape names the same character
 * to the runtime while leaving the file plain text, so a separator or sentinel
 * keeps working unchanged.
 *
 * Detection is over the raw source text rather than over string-literal nodes,
 * because the tool damage is textual — a NUL in a comment, a template, or a
 * regex blinds grep just as completely as one in a literal.
 *
 * A vendored rule because no core rule expresses it: `no-control-regex` covers
 * regexes only, and `no-irregular-whitespace` does not treat NUL as
 * whitespace.
 *
 * The rule's own sources must never contain the byte they ban, so both this
 * file and its test build it with `String.fromCodePoint(0)`.
 */

const NUL = String.fromCodePoint(0);

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid the raw NUL byte in source text; it makes text tools treat the file as binary and skip it silently.',
    },
    schema: [],
    messages: {
      rawNul: String.raw`Raw NUL byte (U+0000) — text tools classify this file as binary and skip it with no warning, so grep silently stops seeing anything in it. Write the same character as the escape '\u0000'.`,
    },
  },
  create(context) {
    return {
      Program() {
        const text = context.sourceCode.getText();
        for (let index = text.indexOf(NUL); index !== -1; index = text.indexOf(NUL, index + 1)) {
          context.report({
            loc: {
              start: context.sourceCode.getLocFromIndex(index),
              end: context.sourceCode.getLocFromIndex(index + 1),
            },
            messageId: 'rawNul',
          });
        }
      },
    };
  },
};
