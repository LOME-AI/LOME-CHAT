import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildCorsXml,
  configureR2Cors,
  parseCliArgs,
  PRODUCTION_ALLOWED_ORIGINS,
  type ConfigureR2CorsDeps,
} from './configure-cors';

describe('buildCorsXml', () => {
  it('emits a CORSConfiguration with one CORSRule per origin', () => {
    const xml = buildCorsXml({
      origins: ['https://hushbox.ai', 'https://*.hushbox.pages.dev'],
      methods: ['GET'],
      allowedHeaders: ['*'],
      maxAgeSeconds: 3600,
    });
    expect(xml).toContain('<CORSConfiguration>');
    expect(xml).toContain('<CORSRule>');
    expect(xml).toContain('<AllowedOrigin>https://hushbox.ai</AllowedOrigin>');
    expect(xml).toContain('<AllowedOrigin>https://*.hushbox.pages.dev</AllowedOrigin>');
    expect(xml).toContain('<AllowedMethod>GET</AllowedMethod>');
    expect(xml).toContain('<AllowedHeader>*</AllowedHeader>');
    expect(xml).toContain('<MaxAgeSeconds>3600</MaxAgeSeconds>');
    expect(xml).toContain('</CORSConfiguration>');
  });

  it('defaults to the production origin allowlist when invoked with PRODUCTION_ALLOWED_ORIGINS', () => {
    const xml = buildCorsXml({
      origins: PRODUCTION_ALLOWED_ORIGINS,
      methods: ['GET'],
      allowedHeaders: ['*'],
      maxAgeSeconds: 3600,
    });
    expect(xml).toContain('https://hushbox.ai');
    expect(xml).toContain('https://*.hushbox.pages.dev');
  });

  it('escapes XML entities in origins to prevent malformed XML', () => {
    const xml = buildCorsXml({
      origins: ['https://example.com/a&b'],
      methods: ['GET'],
      allowedHeaders: ['*'],
      maxAgeSeconds: 3600,
    });
    expect(xml).toContain('https://example.com/a&amp;b');
    expect(xml).not.toContain('a&b<');
  });
});

describe('PRODUCTION_ALLOWED_ORIGINS', () => {
  it('includes the Capacitor WebView origins so native apps can fetch media', () => {
    // Must mirror CAPACITOR_ORIGINS in apps/api/src/middleware/cors.ts: the
    // mobile WebView fetches presigned R2 URLs from these origins and is
    // CORS-checked (CapacitorHttp is disabled, so fetch is not proxied natively).
    expect(PRODUCTION_ALLOWED_ORIGINS).toContain('capacitor://localhost');
    expect(PRODUCTION_ALLOWED_ORIGINS).toContain('http://localhost');
  });
});

describe('configureR2Cors', () => {
  const baseEnv = {
    R2_S3_ENDPOINT: 'https://abc.r2.cloudflarestorage.com',
    R2_ADMIN_ACCESS_KEY_ID: 'test-key',
    R2_ADMIN_SECRET_ACCESS_KEY: 'test-secret',
    R2_BUCKET_MEDIA: 'hushbox-media',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PUTs the CORS XML to {endpoint}/{bucket}?cors with the AWS-signed client', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('', { status: 200 }));
    const deps: ConfigureR2CorsDeps = {
      env: baseEnv,
      createClient: vi.fn().mockReturnValue({ fetch: fetchMock }),
    };

    await configureR2Cors(deps);

    expect(deps.createClient).toHaveBeenCalledWith({
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
      service: 's3',
      region: 'auto',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://abc.r2.cloudflarestorage.com/hushbox-media?cors');
    expect((init as { method: string }).method).toBe('PUT');
    const body = (init as { body: string }).body;
    expect(body).toContain('https://hushbox.ai');
    expect(body).toContain('https://*.hushbox.pages.dev');
    expect(body).toContain('<AllowedMethod>GET</AllowedMethod>');
    expect(body).toContain('<MaxAgeSeconds>3600</MaxAgeSeconds>');
    expect(body).toContain('<AllowedHeader>*</AllowedHeader>');
  });

  it('throws when the CORS PUT returns a non-OK response', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('access denied', { status: 403 }));
    const deps: ConfigureR2CorsDeps = {
      env: baseEnv,
      createClient: vi.fn().mockReturnValue({ fetch: fetchMock }),
    };

    await expect(configureR2Cors(deps)).rejects.toThrow(/403/);
  });

  // Characterization: when the error body itself cannot be read, the thrown
  // error still carries the status code plus the unreadable-body placeholder.
  it('reports the status code when the error body is unreadable', async () => {
    const unreadable = {
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error('stream already consumed')),
    } as unknown as Response;
    const fetchMock = vi.fn().mockResolvedValueOnce(unreadable);
    const deps: ConfigureR2CorsDeps = {
      env: baseEnv,
      createClient: vi.fn().mockReturnValue({ fetch: fetchMock }),
    };

    await expect(configureR2Cors(deps)).rejects.toThrow(/500.*<unreadable body>/);
  });

  it('fails fast when R2_S3_ENDPOINT is missing', async () => {
    const deps: ConfigureR2CorsDeps = {
      env: { ...baseEnv, R2_S3_ENDPOINT: '' },
      createClient: vi.fn(),
    };

    await expect(configureR2Cors(deps)).rejects.toThrow(/R2_S3_ENDPOINT/);
  });

  it('fails fast when R2_ADMIN_ACCESS_KEY_ID is missing', async () => {
    const deps: ConfigureR2CorsDeps = {
      env: { ...baseEnv, R2_ADMIN_ACCESS_KEY_ID: '' },
      createClient: vi.fn(),
    };

    await expect(configureR2Cors(deps)).rejects.toThrow(/R2_ADMIN_ACCESS_KEY_ID/);
  });

  it('fails fast when R2_ADMIN_SECRET_ACCESS_KEY is missing', async () => {
    const deps: ConfigureR2CorsDeps = {
      env: { ...baseEnv, R2_ADMIN_SECRET_ACCESS_KEY: '' },
      createClient: vi.fn(),
    };

    await expect(configureR2Cors(deps)).rejects.toThrow(/R2_ADMIN_SECRET_ACCESS_KEY/);
  });

  it('fails fast when R2_BUCKET_MEDIA is missing', async () => {
    const deps: ConfigureR2CorsDeps = {
      env: { ...baseEnv, R2_BUCKET_MEDIA: '' },
      createClient: vi.fn(),
    };

    await expect(configureR2Cors(deps)).rejects.toThrow(/R2_BUCKET_MEDIA/);
  });
});

describe('parseCliArgs', () => {
  it('returns default origins when no override is provided', () => {
    const result = parseCliArgs([]);
    expect(result).toEqual({ origins: PRODUCTION_ALLOWED_ORIGINS });
  });

  it('parses --origins=a,b,c into an array', () => {
    const result = parseCliArgs(['--origins=https://a,https://b']);
    expect(result).toEqual({ origins: ['https://a', 'https://b'] });
  });

  it('returns an error when an origin is empty', () => {
    const result = parseCliArgs(['--origins=']);
    expect(result).toEqual({ error: expect.stringContaining('--origins=') });
  });

  // Characterization: a blank segment inside an otherwise non-empty list
  // (e.g. a stray double comma) is rejected, not silently dropped.
  it('returns an error when the origins list contains an empty segment', () => {
    const result = parseCliArgs(['--origins=https://a,,https://b']);
    expect(result).toEqual({ error: expect.stringContaining('--origins=') });
  });
});

// Uncoverable branch note: escapeXml's `?? c` fallback (the right side of
// `XML_ENTITY_MAP[c] ?? c`) is unreachable — the replaceAll regex matches
// exactly the five characters that are keys of XML_ENTITY_MAP, so the index
// lookup can never miss. The fallback exists only to satisfy the
// `string | undefined` index signature under noUncheckedIndexedAccess.
