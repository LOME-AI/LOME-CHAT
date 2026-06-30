import { describe, it, expect } from 'vitest';
import {
  CryptoError,
  DecryptionError,
  InvalidBlobError,
  KeyDerivationError,
} from './crypto-errors.js';

describe('CryptoError', () => {
  it('extends Error', () => {
    const error = new CryptoError('test');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(CryptoError);
  });

  it('has correct name', () => {
    const error = new CryptoError('test');
    expect(error.name).toBe('CryptoError');
  });

  it('preserves message', () => {
    const error = new CryptoError('something went wrong');
    expect(error.message).toBe('something went wrong');
  });
});

describe('DecryptionError', () => {
  it('extends CryptoError', () => {
    const error = new DecryptionError('test');
    expect(error).toBeInstanceOf(CryptoError);
    expect(error).toBeInstanceOf(DecryptionError);
  });

  it('has correct name', () => {
    const error = new DecryptionError('test');
    expect(error.name).toBe('DecryptionError');
  });

  it('preserves message', () => {
    const error = new DecryptionError('bad key');
    expect(error.message).toBe('bad key');
  });
});

describe('InvalidBlobError', () => {
  it('extends CryptoError', () => {
    const error = new InvalidBlobError('test');
    expect(error).toBeInstanceOf(CryptoError);
    expect(error).toBeInstanceOf(InvalidBlobError);
  });

  it('has correct name', () => {
    const error = new InvalidBlobError('test');
    expect(error.name).toBe('InvalidBlobError');
  });

  it('preserves message', () => {
    const error = new InvalidBlobError('truncated');
    expect(error.message).toBe('truncated');
  });
});

describe('KeyDerivationError', () => {
  it('extends CryptoError', () => {
    const error = new KeyDerivationError('test');
    expect(error).toBeInstanceOf(CryptoError);
    expect(error).toBeInstanceOf(KeyDerivationError);
  });

  it('has correct name', () => {
    const error = new KeyDerivationError('test');
    expect(error.name).toBe('KeyDerivationError');
  });

  it('preserves message', () => {
    const error = new KeyDerivationError('invalid seed');
    expect(error.message).toBe('invalid seed');
  });
});
