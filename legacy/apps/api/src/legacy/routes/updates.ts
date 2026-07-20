import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { ERROR_CODE_BUILD_NOT_FOUND, MOBILE_PLATFORMS } from '@hushbox/shared';
import { createErrorResponse } from '../lib/error-response.js';
import { getVersionOverride } from '../lib/version-override.js';
import type { AppEnv } from '../types.js';

export const updatesRoute = new Hono<AppEnv>()
  .get('/current', (c) => {
    const version = getVersionOverride() ?? c.env.APP_VERSION;
    return c.json({ version }, 200);
  })

  .get(
    '/download/:platform/:version',
    zValidator(
      'param',
      z.object({
        platform: z.enum(MOBILE_PLATFORMS as unknown as [string, ...string[]]),
        version: z.string().min(1),
      })
    ),
    async (c) => {
      const { platform, version } = c.req.valid('param');
      const bucket = c.env.APP_BUILDS;

      if (!bucket) {
        return c.json(createErrorResponse(ERROR_CODE_BUILD_NOT_FOUND), 404);
      }

      const object = await bucket.get(`builds/${platform}/${version}.zip`);
      if (!object) {
        return c.json(createErrorResponse(ERROR_CODE_BUILD_NOT_FOUND), 404);
      }

      return new Response(object.body, {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-length': String(object.size),
          'cache-control': 'public, max-age=86400, immutable',
        },
      });
    }
  );
