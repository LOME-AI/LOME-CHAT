// Single source of truth for the network hosts the on-device Kokoro TTS model
// download reaches, and the same-origin path its onnxruntime-web runtime is
// self-hosted at. Shared so the hosts the engine fetches and the hosts the CSP
// allows cannot drift apart.

/**
 * The Hugging Face hub host the engine fetches model config, tokenizer, and
 * (via a 302 redirect to the Xet CDN) weight/voice files from. No trailing
 * slash: this is the CSP host form.
 */
export const TTS_MODEL_HOST = 'https://huggingface.co';

/**
 * `connect-src` hosts the model download reaches. The hub host plus the
 * Xet-CDN wildcard: large LFS files 302-redirect off the hub to a
 * region-variable subdomain of `hf.co` (e.g. `us.aws.cdn.hf.co`), and CSP
 * checks `connect-src` at every redirect hop, so the redirect target's origin
 * must also be allowed. The subdomain varies by region, so a wildcard is
 * required; the classic `cdn-lfs.huggingface.co` host is not used by this
 * model. No third-party CDN (the onnxruntime WASM is self-hosted, not fetched
 * from jsdelivr) enters this set.
 */
export const TTS_MODEL_CONNECT_SRC = [TTS_MODEL_HOST, 'https://*.hf.co'] as const;

/**
 * Same-origin absolute path the onnxruntime-web `.wasm`/`.mjs` runtime assets
 * are self-hosted at. Shared so the path they are emitted to and the path the
 * runtime is pointed at cannot drift apart.
 */
export const TTS_ORT_WASM_PATH = '/ort/';
