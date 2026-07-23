/**
 * Bans the reasoning-format delimiter literals `<think>` / `</think>` outside
 * the one shared parser/serializer module.
 *
 * G7: the canonical inline reasoning format is owned by
 * `packages/shared/src/reasoning-format.ts` — the ONLY code that may read or
 * write the delimiters. Every other consumer (client display, optimistic
 * assembly, history-replay stripping) goes through its exported API, so a
 * delimiter string appearing anywhere else is a second implementation in the
 * making. Detection is on string values (string literals and template quasis),
 * not comments — prose may mention the format; code may not write it.
 *
 * Exemption is by ABSOLUTE filename suffix (the parser module and its
 * colocated test), so the repo-wide `files` glob is safe under any consuming
 * package's glob base path.
 */

const DELIMITERS = ['<think>', '</think>'];

const EXEMPT_SUFFIXES = [
  'packages/shared/src/reasoning-format.ts',
  'packages/shared/src/reasoning-format.test.ts',
];

/** True when the string value carries either delimiter. */
function carriesDelimiter(value) {
  return DELIMITERS.some((delimiter) => value.includes(delimiter));
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid the <think>/</think> reasoning delimiters outside the shared reasoning-format module (G7: one parser/serializer).',
    },
    schema: [],
    messages: {
      banned:
        'The <think> delimiters belong to packages/shared/src/reasoning-format.ts alone — build or parse the inline reasoning format through its exported API, never by writing the literal tags.',
    },
  },
  create(context) {
    const filename = context.filename.replaceAll('\\', '/');
    if (EXEMPT_SUFFIXES.some((suffix) => filename.endsWith(suffix))) return {};

    return {
      Literal(node) {
        if (typeof node.value === 'string' && carriesDelimiter(node.value)) {
          context.report({ node, messageId: 'banned' });
        }
      },
      TemplateElement(node) {
        if (carriesDelimiter(node.value.cooked ?? node.value.raw)) {
          context.report({ node, messageId: 'banned' });
        }
      },
    };
  },
};
