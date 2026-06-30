import { describe, it, expect } from 'vitest';
import {
  CryptoError,
  InvalidKeyError,
  InvalidParameterError,
  MalformedBlobError,
  UnknownBlobVersionError,
  DecryptionFailedError,
  DecompressionCapError,
  DecompressionInvalidError,
  EpochNotInChainError,
  ChunkStreamError,
} from './errors.js';

describe('errors', () => {
  it('CryptoError extends Error with its own name', () => {
    const error = new CryptoError('boom');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CryptoError');
    expect(error.message).toBe('boom');
  });

  it('InvalidKeyError extends CryptoError', () => {
    const error = new InvalidKeyError('bad key');

    expect(error).toBeInstanceOf(CryptoError);
    expect(error.name).toBe('InvalidKeyError');
  });

  it('InvalidParameterError extends CryptoError', () => {
    const error = new InvalidParameterError('bad parameter');

    expect(error).toBeInstanceOf(CryptoError);
    expect(error.name).toBe('InvalidParameterError');
  });

  it('MalformedBlobError extends CryptoError', () => {
    const error = new MalformedBlobError('too short');

    expect(error).toBeInstanceOf(CryptoError);
    expect(error.name).toBe('MalformedBlobError');
  });

  it('UnknownBlobVersionError carries the rejected version', () => {
    const error = new UnknownBlobVersionError(0x07);

    expect(error).toBeInstanceOf(CryptoError);
    expect(error.name).toBe('UnknownBlobVersionError');
    expect(error.version).toBe(0x07);
    expect(error.message).toContain('7');
  });

  it('DecryptionFailedError extends CryptoError', () => {
    const error = new DecryptionFailedError('nope');

    expect(error).toBeInstanceOf(CryptoError);
    expect(error.name).toBe('DecryptionFailedError');
  });

  it('DecompressionCapError carries cap and observed byte counts', () => {
    const error = new DecompressionCapError(1024, 2048);

    expect(error).toBeInstanceOf(CryptoError);
    expect(error.name).toBe('DecompressionCapError');
    expect(error.capBytes).toBe(1024);
    expect(error.bytesInflated).toBe(2048);
    expect(error.message).toContain('1024');
  });

  it('DecompressionInvalidError extends CryptoError', () => {
    const error = new DecompressionInvalidError('corrupt stream');

    expect(error).toBeInstanceOf(CryptoError);
    expect(error.name).toBe('DecompressionInvalidError');
  });

  it('EpochNotInChainError carries the missing epoch number', () => {
    const error = new EpochNotInChainError(42);

    expect(error).toBeInstanceOf(CryptoError);
    expect(error.name).toBe('EpochNotInChainError');
    expect(error.epochNumber).toBe(42);
    expect(error.message).toContain('42');
  });

  it('ChunkStreamError extends CryptoError', () => {
    const error = new ChunkStreamError('empty stream');

    expect(error).toBeInstanceOf(CryptoError);
    expect(error.name).toBe('ChunkStreamError');
  });
});
