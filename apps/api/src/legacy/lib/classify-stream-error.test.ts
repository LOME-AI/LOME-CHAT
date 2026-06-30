import { describe, expect, it } from 'vitest';
import {
  ERROR_CODE_CONTENT_POLICY,
  ERROR_CODE_CONTEXT_LENGTH_EXCEEDED,
  ERROR_CODE_DUPLICATE_MESSAGE,
  ERROR_CODE_FORK_TIP_CONFLICT,
  ERROR_CODE_INFERENCE_FAILED,
  ERROR_CODE_NETWORK_ERROR,
  ERROR_CODE_PROVIDER_BILLING,
  ERROR_CODE_RATE_LIMITED,
  ERROR_CODE_STREAM_ERROR,
} from '@hushbox/shared';
import { classifyStreamErrorCode } from './classify-stream-error.js';

describe('classifyStreamErrorCode', () => {
  it('returns STREAM_ERROR for non-Error values', () => {
    expect(classifyStreamErrorCode('boom')).toBe(ERROR_CODE_STREAM_ERROR);
    expect(classifyStreamErrorCode(null)).toBe(ERROR_CODE_STREAM_ERROR);
    expect(classifyStreamErrorCode(42)).toBe(ERROR_CODE_STREAM_ERROR);
  });

  it('returns STREAM_ERROR for a non-AI-SDK Error with no other classification', () => {
    expect(classifyStreamErrorCode(new Error('something else broke'))).toBe(
      ERROR_CODE_STREAM_ERROR
    );
  });

  describe('inference failed', () => {
    it('classifies AI SDK errors (name prefixed with AI_) as INFERENCE_FAILED', () => {
      const error = new Error('upstream provider returned 500');
      error.name = 'AI_APICallError';
      expect(classifyStreamErrorCode(error)).toBe(ERROR_CODE_INFERENCE_FAILED);
    });

    it('classifies generic AISDKError as INFERENCE_FAILED', () => {
      const error = new Error('SDK invariant');
      error.name = 'AISDKError';
      expect(classifyStreamErrorCode(error)).toBe(ERROR_CODE_INFERENCE_FAILED);
    });

    it('still routes specific buckets first (rate limit beats inference failed)', () => {
      const error = Object.assign(new Error('Provider rate limit exceeded'), { status: 429 });
      error.name = 'AI_APICallError';
      expect(classifyStreamErrorCode(error)).toBe(ERROR_CODE_RATE_LIMITED);
    });

    it('still routes specific buckets first (network beats inference failed)', () => {
      const error = new TypeError('fetch failed connecting');
      error.name = 'AI_APICallError';
      expect(classifyStreamErrorCode(error)).toBe(ERROR_CODE_NETWORK_ERROR);
    });
  });

  it('classifies context-length errors', () => {
    expect(classifyStreamErrorCode(new Error('input exceeds context length of 200000'))).toBe(
      ERROR_CODE_CONTEXT_LENGTH_EXCEEDED
    );
  });

  it('classifies fork-tip conflict by error name', () => {
    const error = new Error('parent message id mismatch');
    error.name = 'ForkTipConflictError';
    expect(classifyStreamErrorCode(error)).toBe(ERROR_CODE_FORK_TIP_CONFLICT);
  });

  it('classifies unique-violation via message text', () => {
    expect(
      classifyStreamErrorCode(new Error('duplicate key value violates unique constraint'))
    ).toBe(ERROR_CODE_DUPLICATE_MESSAGE);
  });

  it('classifies unique-violation via cause.code 23505', () => {
    const cause = Object.assign(new Error('inner'), { code: '23505' });
    const error = new Error('insert failed', { cause });
    expect(classifyStreamErrorCode(error)).toBe(ERROR_CODE_DUPLICATE_MESSAGE);
  });

  describe('rate limit', () => {
    it('classifies HTTP 429 status', () => {
      const error = Object.assign(new Error('Too Many Requests'), { status: 429 });
      expect(classifyStreamErrorCode(error)).toBe(ERROR_CODE_RATE_LIMITED);
    });

    it('classifies "rate limit" in message', () => {
      expect(classifyStreamErrorCode(new Error('Provider returned rate limit exceeded'))).toBe(
        ERROR_CODE_RATE_LIMITED
      );
    });

    it('classifies "429" in message', () => {
      expect(classifyStreamErrorCode(new Error('upstream returned 429'))).toBe(
        ERROR_CODE_RATE_LIMITED
      );
    });
  });

  describe('content policy', () => {
    it('classifies "content policy" in message', () => {
      expect(classifyStreamErrorCode(new Error('Refused: violates content policy'))).toBe(
        ERROR_CODE_CONTENT_POLICY
      );
    });

    it('classifies "safety" in message', () => {
      expect(classifyStreamErrorCode(new Error('blocked due to safety filter'))).toBe(
        ERROR_CODE_CONTENT_POLICY
      );
    });

    it('classifies "moderation" in message', () => {
      expect(classifyStreamErrorCode(new Error('moderation rejected the prompt'))).toBe(
        ERROR_CODE_CONTENT_POLICY
      );
    });

    it('classifies "harmful" in message', () => {
      expect(classifyStreamErrorCode(new Error('harmful content detected'))).toBe(
        ERROR_CODE_CONTENT_POLICY
      );
    });
  });

  describe('provider billing', () => {
    it('classifies HTTP 401', () => {
      const error = Object.assign(new Error('Unauthorized'), { status: 401 });
      expect(classifyStreamErrorCode(error)).toBe(ERROR_CODE_PROVIDER_BILLING);
    });

    it('classifies HTTP 402', () => {
      const error = Object.assign(new Error('Payment Required'), { status: 402 });
      expect(classifyStreamErrorCode(error)).toBe(ERROR_CODE_PROVIDER_BILLING);
    });

    it('classifies HTTP 403', () => {
      const error = Object.assign(new Error('Forbidden'), { status: 403 });
      expect(classifyStreamErrorCode(error)).toBe(ERROR_CODE_PROVIDER_BILLING);
    });

    it('classifies "insufficient credits" in message', () => {
      expect(classifyStreamErrorCode(new Error('Provider: insufficient credits on account'))).toBe(
        ERROR_CODE_PROVIDER_BILLING
      );
    });
  });

  describe('network errors', () => {
    it('classifies TypeError "fetch failed"', () => {
      expect(classifyStreamErrorCode(new TypeError('fetch failed'))).toBe(ERROR_CODE_NETWORK_ERROR);
    });

    it('classifies AbortError', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      expect(classifyStreamErrorCode(error)).toBe(ERROR_CODE_NETWORK_ERROR);
    });

    it('classifies plain Error with "fetch failed" message', () => {
      expect(classifyStreamErrorCode(new Error('upstream fetch failed connecting'))).toBe(
        ERROR_CODE_NETWORK_ERROR
      );
    });
  });

  describe('precedence', () => {
    it('context length wins over rate limit message', () => {
      const error = Object.assign(new Error('exceeds context length and rate limit'), {
        status: 429,
      });
      expect(classifyStreamErrorCode(error)).toBe(ERROR_CODE_CONTEXT_LENGTH_EXCEEDED);
    });

    it('fork tip wins over content policy', () => {
      const error = new Error('content policy mismatch');
      error.name = 'ForkTipConflictError';
      expect(classifyStreamErrorCode(error)).toBe(ERROR_CODE_FORK_TIP_CONFLICT);
    });
  });
});
