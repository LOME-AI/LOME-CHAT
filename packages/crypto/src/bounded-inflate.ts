import { Inflate } from 'fflate';
import {
  DecompressionCapError,
  DecompressionInvalidError,
  InvalidParameterError,
} from './errors.js';

/**
 * Compressed input is fed to the streaming inflater in slices of this size.
 * fflate materializes each push's full output before invoking `ondata`, so
 * the slice size — not the caller's chunking — bounds how far past the cap
 * a single step can inflate: DEFLATE expands at most ~1032:1, giving a
 * worst-case overshoot of ~1 MiB per slice. Feeding the whole input in one
 * push would be inflate-then-measure, which the cap exists to prevent.
 */
const INPUT_SLICE_BYTES = 1024;

function toChunks(compressed: Uint8Array | readonly Uint8Array[]): readonly Uint8Array[] {
  return compressed instanceof Uint8Array ? [compressed] : compressed;
}

function pushSlices(inflater: Inflate, chunks: readonly Uint8Array[]): void {
  const totalInput = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (totalInput === 0) {
    throw new DecompressionInvalidError('Empty compressed input');
  }
  let consumed = 0;
  for (const chunk of chunks) {
    for (let offset = 0; offset < chunk.length; offset += INPUT_SLICE_BYTES) {
      const slice = chunk.subarray(offset, offset + INPUT_SLICE_BYTES);
      consumed += slice.length;
      inflater.push(slice, consumed === totalInput);
    }
  }
}

/**
 * Inflates a raw-deflate stream, aborting mid-inflate the moment cumulative
 * output exceeds `maxOutputBytes`. The cap is an absolute byte limit and a
 * required parameter — never a compression-ratio heuristic, never
 * inflate-then-measure. Pure function over byte chunks: safe for both
 * client-side use and DO ingest.
 */
export function boundedInflate(
  compressed: Uint8Array | readonly Uint8Array[],
  maxOutputBytes: number
): Uint8Array {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new InvalidParameterError(
      `maxOutputBytes must be a positive safe integer, got ${String(maxOutputBytes)}`
    );
  }

  const outputs: Uint8Array[] = [];
  let totalOutput = 0;
  const inflater = new Inflate((data) => {
    totalOutput += data.length;
    if (totalOutput > maxOutputBytes) {
      throw new DecompressionCapError(maxOutputBytes, totalOutput);
    }
    outputs.push(data);
  });

  try {
    pushSlices(inflater, toChunks(compressed));
  } catch (error) {
    if (error instanceof DecompressionCapError || error instanceof DecompressionInvalidError) {
      throw error;
    }
    throw new DecompressionInvalidError(`Invalid deflate stream: ${String(error)}`);
  }

  const result = new Uint8Array(totalOutput);
  let offset = 0;
  for (const part of outputs) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
