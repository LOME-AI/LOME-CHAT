import { describe, expect, it } from 'vitest';
import { parseListObjectsV2Response } from './list-xml.js';

function contentsBlock(key: string, size = '10'): string {
  return `<Contents><Key>${key}</Key><LastModified>2026-06-11T00:00:00.000Z</LastModified><Size>${size}</Size></Contents>`;
}

describe('parseListObjectsV2Response', () => {
  it('parses key, uploaded date, and size from a Contents block', () => {
    const xml = `<ListBucketResult>${contentsBlock('media/a', '64')}<IsTruncated>false</IsTruncated></ListBucketResult>`;
    const page = parseListObjectsV2Response(xml);
    expect(page.objects).toEqual([
      { key: 'media/a', uploaded: new Date('2026-06-11T00:00:00.000Z'), size: 64 },
    ]);
  });

  it('decodes XML entities in keys', () => {
    const xml = `<ListBucketResult>${contentsBlock('media/a&amp;b&lt;&gt;&quot;&apos;')}<IsTruncated>false</IsTruncated></ListBucketResult>`;
    const page = parseListObjectsV2Response(xml);
    expect(page.objects[0]?.key).toBe(`media/a&b<>"'`);
  });

  it('decodes a double-encoded entity once, not twice', () => {
    // S3 encodes the literal key "media/&lt;" as "media/&amp;lt;". Decoding
    // must yield the literal "&lt;" — a second pass (or decoding &amp;
    // before the other entities) would over-decode it to "<".
    const xml = `<ListBucketResult>${contentsBlock('media/&amp;lt;')}<IsTruncated>false</IsTruncated></ListBucketResult>`;
    const page = parseListObjectsV2Response(xml);
    expect(page.objects[0]?.key).toBe('media/&lt;');
  });

  it('tolerates namespace-prefixed tags', () => {
    const xml =
      '<s3:ListBucketResult><s3:Contents><s3:Key>media/ns</s3:Key><s3:LastModified>2026-06-11T00:00:00.000Z</s3:LastModified><s3:Size>1</s3:Size></s3:Contents><s3:IsTruncated>false</s3:IsTruncated></s3:ListBucketResult>';
    const page = parseListObjectsV2Response(xml);
    expect(page.objects[0]?.key).toBe('media/ns');
  });

  it('returns a nextCursor when the listing is truncated', () => {
    const xml = `<ListBucketResult>${contentsBlock('media/a')}<IsTruncated>true</IsTruncated><NextContinuationToken>token-1</NextContinuationToken></ListBucketResult>`;
    expect(parseListObjectsV2Response(xml).nextCursor).toBe('token-1');
  });

  it('omits nextCursor when the listing is not truncated', () => {
    const xml = `<ListBucketResult>${contentsBlock('media/a')}<IsTruncated>false</IsTruncated><NextContinuationToken>stale</NextContinuationToken></ListBucketResult>`;
    expect(parseListObjectsV2Response(xml).nextCursor).toBeUndefined();
  });

  it('treats a self-closing IsTruncated tag as not truncated', () => {
    const xml = `<ListBucketResult>${contentsBlock('media/a')}<IsTruncated/></ListBucketResult>`;
    expect(parseListObjectsV2Response(xml).nextCursor).toBeUndefined();
  });

  it('skips Contents blocks missing a required tag', () => {
    const xml =
      '<ListBucketResult><Contents><Key>media/incomplete</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>';
    expect(parseListObjectsV2Response(xml).objects).toEqual([]);
  });

  it('throws on a non-numeric Size', () => {
    const xml = `<ListBucketResult>${contentsBlock('media/a', 'NaN-bytes')}<IsTruncated>false</IsTruncated></ListBucketResult>`;
    expect(() => parseListObjectsV2Response(xml)).toThrow(/Size/);
  });
});
