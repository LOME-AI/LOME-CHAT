// @ts-check

/**
 * Cross-platform `no-restricted-syntax` selectors applied to every file by the
 * base config: block shell-outs to POSIX-only commands and embedded shells.
 * Use Node fs APIs, scripts/kill-ports.ts, archiver/adm-zip, the 'open'
 * package, native fetch, or dedicated tsx wrappers. Reaches execa(), execSync,
 * execFileSync, spawn, spawnSync.
 *
 * Allowed commands: git, docker, node, pnpm, npm, tsx, wrangler, playwright,
 * vitest, drizzle-kit, etc. — cross-platform tools.
 *
 * Exported separately because flat config replaces (never merges) a rule key:
 * any config entry that sets `no-restricted-syntax` for files the base config
 * also covers must re-list these selectors or they silently vanish for those
 * files (see eslint-extensions/README.md).
 *
 * @type {{selector: string, message: string}[]}
 */
/* eslint-disable no-secrets/no-secrets -- the command-list AST selectors trip
   the entropy heuristic; they are public selector strings, not credentials. */
export const crossPlatformRestrictedSyntax = [
  {
    selector:
      "CallExpression[callee.name='execa'][arguments.0.type='Literal'][arguments.0.value=/^(rm|mv|cp|mkdir|chmod|chown|lsof|xargs|kill|killall|pkill|grep|sed|awk|tr|cut|find|unzip|zip|stat|yes|touch|tail|head|sudo|sh|bash|zsh|fish|curl|wget|xdg-open)$/]",
    message:
      'Cross-platform: do not execa POSIX-only commands. Use Node fs APIs, scripts/kill-ports.ts, archiver/adm-zip, the open package, native fetch, or a tsx wrapper.',
  },
  {
    selector:
      "CallExpression[callee.name=/^(execFileSync|spawn|spawnSync)$/][arguments.0.type='Literal'][arguments.0.value=/^(rm|mv|cp|mkdir|chmod|chown|lsof|xargs|kill|killall|pkill|grep|sed|awk|tr|cut|find|unzip|zip|stat|yes|touch|tail|head|sudo|sh|bash|zsh|fish|curl|wget|xdg-open)$/]",
    message:
      'Cross-platform: do not invoke POSIX-only commands via execFileSync/spawn. Use Node fs APIs, scripts/kill-ports.ts, archiver/adm-zip, the open package, native fetch, or a tsx wrapper.',
  },
  {
    selector: String.raw`CallExpression[callee.name='execSync'][arguments.0.type='Literal'][arguments.0.value=/^(rm|mv|cp|mkdir|chmod|chown|lsof|xargs|kill|killall|pkill|grep|sed|awk|tr|cut|find|unzip|zip|stat|yes|touch|tail|head|sudo|sh|bash|zsh|fish|curl|wget|xdg-open)(\s|$)/]`,
    message:
      'Cross-platform: do not execSync POSIX-only shell strings. Use Node APIs or a tsx wrapper.',
  },
];
/* eslint-enable no-secrets/no-secrets */
