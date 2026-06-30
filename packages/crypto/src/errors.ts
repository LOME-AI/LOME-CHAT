export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

export class InvalidKeyError extends CryptoError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidKeyError';
  }
}

export class InvalidParameterError extends CryptoError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidParameterError';
  }
}

export class MalformedBlobError extends CryptoError {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedBlobError';
  }
}

export class UnknownBlobVersionError extends CryptoError {
  readonly version: number;

  constructor(version: number) {
    super(`Unknown blob format version: ${String(version)}`);
    this.name = 'UnknownBlobVersionError';
    this.version = version;
  }
}

export class DecryptionFailedError extends CryptoError {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionFailedError';
  }
}

export class DecompressionCapError extends CryptoError {
  readonly capBytes: number;
  readonly bytesInflated: number;

  constructor(capBytes: number, bytesInflated: number) {
    super(
      `Decompression aborted: output exceeded cap of ${String(capBytes)} bytes ` +
        `(${String(bytesInflated)} bytes inflated at abort)`
    );
    this.name = 'DecompressionCapError';
    this.capBytes = capBytes;
    this.bytesInflated = bytesInflated;
  }
}

export class DecompressionInvalidError extends CryptoError {
  constructor(message: string) {
    super(message);
    this.name = 'DecompressionInvalidError';
  }
}

export class EpochNotInChainError extends CryptoError {
  readonly epochNumber: number;

  constructor(epochNumber: number) {
    super(`Epoch ${String(epochNumber)} is not in the provided epoch chain`);
    this.name = 'EpochNotInChainError';
    this.epochNumber = epochNumber;
  }
}

export class ChunkStreamError extends CryptoError {
  constructor(message: string) {
    super(message);
    this.name = 'ChunkStreamError';
  }
}
