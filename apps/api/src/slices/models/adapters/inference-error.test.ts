import { describe, expect, it } from 'vitest';
import {
  InferenceError,
  abortedError,
  classifyInferenceFailure,
  emptyCompletionError,
  invalidRequestError,
  truncatedStreamError,
} from './inference-error.js';

function withData(message: string, data: unknown): Error {
  return Object.assign(new Error(message), { data });
}

describe('classifyInferenceFailure', () => {
  it('passes an existing InferenceError through unchanged', () => {
    const original = truncatedStreamError();

    expect(classifyInferenceFailure(original)).toBe(original);
  });

  it('classifies an AbortError as aborted', () => {
    const error = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

    expect(classifyInferenceFailure(error).code).toBe('aborted');
  });

  it('classifies a 429 status as rate_limited', () => {
    const error = Object.assign(new Error('Too many requests'), { statusCode: 429 });

    expect(classifyInferenceFailure(error).code).toBe('rate_limited');
  });

  it('classifies a rate_limit_exceeded body as rate_limited', () => {
    const error = withData('Gateway request failed', {
      error: { message: 'slow down', type: 'rate_limit_exceeded' },
    });

    expect(classifyInferenceFailure(error).code).toBe('rate_limited');
  });

  it('classifies a no_providers_available body as no_providers_available', () => {
    const error = withData('Gateway request failed', {
      error: { message: 'no ZDR providers', type: 'no_providers_available' },
    });

    expect(classifyInferenceFailure(error).code).toBe('no_providers_available');
  });

  it('finds the gateway body through the cause chain', () => {
    const inner = withData('api call failed', {
      error: { message: 'no ZDR providers', type: 'no_providers_available' },
    });
    const outer = new Error('Gateway request failed', { cause: inner });

    expect(classifyInferenceFailure(outer).code).toBe('no_providers_available');
  });

  it('parses a responseBody string when data is absent', () => {
    const error = Object.assign(new Error('api call failed'), {
      responseBody: JSON.stringify({ error: { message: 'nope', type: 'no_providers_available' } }),
    });

    expect(classifyInferenceFailure(error).code).toBe('no_providers_available');
  });

  it('ignores a gateway body whose error type is null', () => {
    const error = Object.assign(new Error('api call failed'), {
      data: { error: { message: 'nope', type: null } },
    });

    expect(classifyInferenceFailure(error).code).toBe('upstream_error');
  });

  it('ignores a non-string responseBody', () => {
    const error = Object.assign(new Error('api call failed'), { responseBody: 42 });

    expect(classifyInferenceFailure(error).code).toBe('upstream_error');
  });

  it('ignores a responseBody that is not valid JSON', () => {
    const error = Object.assign(new Error('api call failed'), { responseBody: 'not json' });

    expect(classifyInferenceFailure(error).code).toBe('upstream_error');
  });

  it('falls back to upstream_error for an unrecognized Error', () => {
    const classified = classifyInferenceFailure(new Error('something broke'));

    expect(classified.code).toBe('upstream_error');
    expect(classified.message).toContain('something broke');
  });

  it('wraps a string failure as upstream_error', () => {
    const classified = classifyInferenceFailure('plain failure');

    expect(classified.code).toBe('upstream_error');
    expect(classified.message).toContain('plain failure');
  });

  it('wraps a non-error value as upstream_error with a generic message', () => {
    const classified = classifyInferenceFailure({ odd: true });

    expect(classified.code).toBe('upstream_error');
  });

  it('preserves the original failure as cause', () => {
    const original = new Error('something broke');

    expect(classifyInferenceFailure(original).cause).toBe(original);
  });
});

describe('error factories', () => {
  it('builds an aborted error carrying the reason', () => {
    const error = abortedError('user stop');

    expect(error).toBeInstanceOf(InferenceError);
    expect(error.code).toBe('aborted');
    expect(error.message).toContain('user stop');
  });

  it('builds an aborted error without a reason', () => {
    expect(abortedError().code).toBe('aborted');
  });

  it('builds a truncated stream error', () => {
    expect(truncatedStreamError().code).toBe('truncated_stream');
  });

  it('builds an empty completion error without a finish reason', () => {
    expect(emptyCompletionError().message).toContain('unknown');
  });

  it('builds an empty completion error naming the finish reason', () => {
    const error = emptyCompletionError('content-filter');

    expect(error.code).toBe('empty_completion');
    expect(error.message).toContain('content-filter');
  });

  it('builds an invalid request error', () => {
    expect(invalidRequestError('bad param').code).toBe('invalid_request');
  });
});
