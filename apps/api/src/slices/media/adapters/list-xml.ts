import type { ListPage } from '../ports/index.js';

/**
 * Hand-rolled S3 ListObjectsV2 XML parser (no XML parser dependency — the
 * response shape is well-defined and stable). Extracts `<Contents>` blocks
 * (key, lastModified, size) plus `<IsTruncated>`/`<NextContinuationToken>`.
 *
 * Tag matching tolerates an optional XML namespace prefix (`s3:Contents`)
 * and self-closing tags (`<IsTruncated/>` parses as empty string).
 *
 * Tag content is XML-entity-decoded for the five named entities S3 emits.
 * Without decoding, a key like `foo&bar` arrives as `foo&amp;bar` and the GC
 * orphan check (comparing against DB-stored, already-decoded keys) would
 * mismatch — and delete a live object. Numeric character references are not
 * used by S3 ListObjectsV2 and intentionally not handled.
 *
 * A non-numeric `<Size>` is a malformed response: the parser throws (the
 * adapter maps it to an `unavailable` DomainError) rather than silently
 * dropping the object from a GC listing.
 */

function decodeXmlEntities(value: string): string {
  // &amp; must decode last: "&amp;lt;" is the encoding of the literal
  // "&lt;", and decoding &amp; first would re-expose it to the &lt; pass
  // (over-decoding to "<"). replaceAll never rescans replaced text, so a
  // trailing &amp; pass cannot cascade either.
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

const NS_PREFIX = String.raw`(?:[a-zA-Z][\w.-]*:)?`;

function extractTag(xml: string, tag: string): string | undefined {
  const selfClosing = new RegExp(String.raw`<${NS_PREFIX}${tag}\s*/>`);
  if (selfClosing.test(xml)) {
    return '';
  }
  const regex = new RegExp(
    String.raw`<${NS_PREFIX}${tag}(?:\s[^>]*)?>([^<]*)</${NS_PREFIX}${tag}>`
  );
  const raw = regex.exec(xml)?.[1];
  return raw === undefined ? undefined : decodeXmlEntities(raw);
}

export function parseListObjectsV2Response(xml: string): ListPage {
  const objects: { key: string; uploaded: Date; size: number }[] = [];
  // No capture group: extractTag searches within the whole matched block,
  // so the <Contents> wrapper tags are harmless and match[0] (always
  // present, unlike a group index) avoids an unreachable undefined branch.
  const contentsRegex = new RegExp(
    String.raw`<${NS_PREFIX}Contents>[\s\S]*?</${NS_PREFIX}Contents>`,
    'g'
  );
  let blockMatch: RegExpExecArray | null = contentsRegex.exec(xml);
  while (blockMatch !== null) {
    const block = blockMatch[0];
    const key = extractTag(block, 'Key');
    const lastModified = extractTag(block, 'LastModified');
    const sizeRaw = extractTag(block, 'Size');
    if (key !== undefined && lastModified !== undefined && sizeRaw !== undefined) {
      const size = Number.parseInt(sizeRaw, 10);
      if (!Number.isFinite(size)) {
        throw new TypeError('ListObjectsV2 response has a non-numeric Size');
      }
      objects.push({ key, uploaded: new Date(lastModified), size });
    }
    blockMatch = contentsRegex.exec(xml);
  }
  const truncated = extractTag(xml, 'IsTruncated') === 'true';
  const nextContinuationToken = truncated ? extractTag(xml, 'NextContinuationToken') : undefined;
  return {
    objects,
    ...(nextContinuationToken !== undefined && { nextCursor: nextContinuationToken }),
  };
}
