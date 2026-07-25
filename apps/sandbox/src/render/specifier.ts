/**
 * Parsing and URL assembly for the bare module specifiers a document imports.
 * Kept pure and separate from the browser bootstrap so the resolution rules are
 * unit-tested in Node, not only exercised in a live frame.
 */

/** A bare specifier split into its package name, optional version, and subpath. */
export interface ParsedSpecifier {
  /** The package name, including any `@scope/` prefix. */
  readonly name: string;
  /** The version if the specifier declared one (`pkg@1.2.3`), else undefined. */
  readonly version: string | undefined;
  /** Any subpath beyond the package, with a leading slash, else `''`. */
  readonly subpath: string;
}

/**
 * Version pins keyed by package name. Applied only when the specifier itself
 * declares no version — an author-named version always wins.
 */
export type VersionPins = Readonly<Record<string, string>>;

/**
 * Split a name token into package name and optional version. `scoped` skips the
 * leading `@` of a `@scope/pkg` name so only a version `@` is matched.
 */
function splitVersion(
  token: string,
  scoped: boolean
): { name: string; version: string | undefined } {
  const at = token.indexOf('@', scoped ? 1 : 0);
  if (at === -1) return { name: token, version: undefined };
  return { name: token.slice(0, at), version: token.slice(at + 1) };
}

/** Parse a bare import specifier into name / version / subpath. */
export function parseSpecifier(specifier: string): ParsedSpecifier {
  const segments = specifier.split('/');
  const scoped = specifier.startsWith('@');
  // A scoped name consumes two path segments (`@scope` + `pkg`); an unscoped
  // name consumes only the first. Everything after is the subpath.
  const nameSegmentCount = scoped ? 2 : 1;
  const { name, version } = splitVersion(segments.slice(0, nameSegmentCount).join('/'), scoped);
  const subSegments = segments.slice(nameSegmentCount);
  return {
    name,
    version,
    subpath: subSegments.length > 0 ? `/${subSegments.join('/')}` : '',
  };
}

/** Assemble the module URL for a bare specifier against a CDN base and pins. */
export function moduleUrlFor(specifier: string, cdnBase: string, pins: VersionPins): string {
  const base = cdnBase.replace(/\/+$/, '');
  const { name, version, subpath } = parseSpecifier(specifier);
  const resolved = version ?? pins[name];
  const versionPart = resolved === undefined ? '' : `@${resolved}`;
  return `${base}/${name}${versionPart}${subpath}`;
}
