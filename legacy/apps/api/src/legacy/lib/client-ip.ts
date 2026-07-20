import { createHash } from 'node:crypto';

export function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex');
}

export interface RequestContext {
  req: {
    header: (name: string) => string | undefined;
  };
}

export function getClientIp(c: RequestContext, fallback = 'unknown'): string {
  const cfIp = c.req.header('cf-connecting-ip');
  if (cfIp) {
    return cfIp;
  }

  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    const firstIp = forwarded.split(',')[0]?.trim();
    if (firstIp) {
      return firstIp;
    }
  }

  const realIp = c.req.header('x-real-ip');
  if (realIp) {
    return realIp;
  }

  return fallback;
}
