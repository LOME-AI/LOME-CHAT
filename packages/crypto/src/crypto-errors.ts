export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

export class DecryptionError extends CryptoError {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

export class InvalidBlobError extends CryptoError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBlobError';
  }
}

export class KeyDerivationError extends CryptoError {
  constructor(message: string) {
    super(message);
    this.name = 'KeyDerivationError';
  }
}
