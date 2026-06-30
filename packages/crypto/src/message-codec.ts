import { compressIfSmaller, decompress } from './compression.js';
import { InvalidBlobError } from './crypto-errors.js';

const FLAG_UNCOMPRESSED = 0x00;
const FLAG_COMPRESSED = 0x01;
const FLAG_BINARY_UNCOMPRESSED = 0x02;

export function encodeForEncryption(plaintext: string): Uint8Array {
  const messageBytes = new TextEncoder().encode(plaintext);
  const { result, compressed } = compressIfSmaller(messageBytes);
  const flag = compressed ? FLAG_COMPRESSED : FLAG_UNCOMPRESSED;

  const payload = new Uint8Array(1 + result.length);
  payload[0] = flag;
  payload.set(result, 1);
  return payload;
}

export function decodeFromDecryption(payload: Uint8Array): string {
  const flag = payload[0];
  if (flag !== FLAG_UNCOMPRESSED && flag !== FLAG_COMPRESSED) {
    throw new InvalidBlobError(`Unexpected text payload flag: ${String(flag)}`);
  }
  let data = payload.subarray(1);

  if (flag === FLAG_COMPRESSED) {
    data = decompress(data);
  }

  return new TextDecoder().decode(data);
}

export function encodeBinary(data: Uint8Array): Uint8Array {
  const payload = new Uint8Array(1 + data.length);
  payload[0] = FLAG_BINARY_UNCOMPRESSED;
  payload.set(data, 1);
  return payload;
}

export function decodeBinary(payload: Uint8Array): Uint8Array {
  if (payload.length === 0 || payload[0] !== FLAG_BINARY_UNCOMPRESSED) {
    throw new InvalidBlobError(`Unexpected binary payload flag: ${String(payload[0])}`);
  }
  return payload.slice(1);
}
