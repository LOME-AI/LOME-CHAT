/**
 * Forbids inlining OpenRouter provider-routing / ZDR option literals in the
 * model adapters. Every call's routing block must come from the single-sourced
 * `languageRoutingOptions` / `mediaRoutingOptions` helpers in
 * `@hushbox/shared`, because OpenRouter's `extraBody.provider` REPLACES
 * `settings.provider` on the wire (it does not deep-merge) — an inline literal
 * that omits `zdr`, `data_collection`, or `allow_fallbacks` silently unpins the
 * ZDR guarantee. Centralizing the shapes makes that impossible to get wrong.
 *
 * Flags, inside adapter code only:
 *   - `{ provider: { zdr: … } }`      — an inline provider-routing block
 *   - `{ extraBody: { provider: … } }` — the media-family routing block inlined
 *
 * Spreading a helper result (`...mediaRoutingOptions()`) is untouched — that is
 * the sanctioned path.
 *
 * Self-scopes by ABSOLUTE filename (flat-config glob base paths differ per
 * consuming package), and exempts the helper module and test files — the
 * latter legitimately hand-author wire fixtures containing these literals.
 */

const DEFAULT_SCOPE = String.raw`/apps/api/src/slices/models/adapters/`;
const DEFAULT_ALLOWED = String.raw`routing-options|\.(test|spec)\.`;

function keyName(property) {
  if (property.type !== 'Property') return;
  const { key } = property;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal') return String(key.value);
}

function objectHasKey(node, name) {
  return (
    node.type === 'ObjectExpression' &&
    node.properties.some((property) => keyName(property) === name)
  );
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Produce OpenRouter routing/ZDR options only via the shared helpers; ban inline provider/extraBody.provider literals in adapter code.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            description:
              'Regex matched against the absolute filename; only matching files are checked.',
          },
          allowedFiles: {
            type: 'string',
            description: 'Regex matched against the absolute filename; matching files are exempt.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      inlineProvider:
        'Inline OpenRouter `provider` routing literal — use languageRoutingOptions()/mediaRoutingOptions() from @hushbox/shared so the ZDR block is single-sourced.',
      inlineExtraBodyProvider:
        'Inline `extraBody.provider` routing literal — use mediaRoutingOptions() from @hushbox/shared (extraBody.provider replaces settings.provider on the wire).',
    },
  },
  create(context) {
    const scope = new RegExp(context.options[0]?.scope ?? DEFAULT_SCOPE);
    const allowed = new RegExp(context.options[0]?.allowedFiles ?? DEFAULT_ALLOWED);
    const filename = context.filename.replaceAll('\\', '/');
    if (!scope.test(filename) || allowed.test(filename)) return {};

    return {
      Property(node) {
        const name = keyName(node);
        if (name === 'provider' && objectHasKey(node.value, 'zdr')) {
          // A `provider` nested directly under `extraBody` is already covered by
          // the extraBody branch below — don't double-report the same literal.
          const enclosing = node.parent?.parent;
          if (enclosing?.type === 'Property' && keyName(enclosing) === 'extraBody') return;
          context.report({ node, messageId: 'inlineProvider' });
          return;
        }
        if (name === 'extraBody' && objectHasKey(node.value, 'provider')) {
          context.report({ node, messageId: 'inlineExtraBodyProvider' });
        }
      },
    };
  },
};
