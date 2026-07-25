import { describe, expect, it } from 'vitest';

import { TTS_MODEL_CONNECT_SRC, TTS_MODEL_HOST, TTS_ORT_WASM_PATH } from './tts-hosts.js';

describe('TTS model hosts', () => {
  it('names the Hugging Face hub host with no trailing slash (CSP host form)', () => {
    expect(TTS_MODEL_HOST).toBe('https://huggingface.co');
  });

  it('lists the hub host plus the Xet-CDN wildcard as the connect-src additions', () => {
    expect(TTS_MODEL_CONNECT_SRC).toEqual(['https://huggingface.co', 'https://*.hf.co']);
  });

  it('includes the hub host itself in the connect-src additions', () => {
    expect(TTS_MODEL_CONNECT_SRC).toContain(TTS_MODEL_HOST);
  });

  it('adds no third-party CDN (jsdelivr) to the connect-src additions', () => {
    for (const host of TTS_MODEL_CONNECT_SRC) {
      expect(host).not.toContain('jsdelivr');
    }
  });

  it('serves the onnxruntime WASM from a same-origin absolute path', () => {
    expect(TTS_ORT_WASM_PATH).toBe('/ort/');
    expect(TTS_ORT_WASM_PATH.startsWith('/')).toBe(true);
    expect(TTS_ORT_WASM_PATH.endsWith('/')).toBe(true);
  });
});
