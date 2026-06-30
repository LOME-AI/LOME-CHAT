import { HTTPException } from 'hono/http-exception';
import { ERROR_CODE_INTERNAL } from '@hushbox/shared';
import { createErrorResponse } from '../lib/error-response.js';
import type { ErrorHandler } from 'hono';

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  return c.json(createErrorResponse(ERROR_CODE_INTERNAL), 500);
};
