// Single source of truth for the friendly first-listen download size shown to
// users before the on-device Kokoro TTS model is fetched. Both user-facing
// surfaces — the accessibility widget's audio section and the blog "Listen"
// card — build their own sentence around this one number, so the figure can
// never disagree between them.
//
// Verified sizing against the Hugging Face repo the engine pins,
// onnx-community/Kokoro-82M-v1.0-ONNX, at the engine's actual dtype (`q8`) on
// WASM. First listen fetches, from that repo: onnx/model_quantized.onnx (the
// q8 weights, 92,361,116 B) + config.json/tokenizer.json/tokenizer_config.json
// (3,654 B) + one voices/*.bin (522,240 B; kokoro-js fetches the selected voice
// from the hub in the browser, reading the bundled copy only under Node) ≈
// 92,887,010 B ≈ 92.9 MB (≈ 88.6 MiB). Rounded to a friendly "about 90 MB".
// The onnxruntime-web WASM is self-hosted same-origin and cached with the app,
// so it is not part of this hub download and is not counted here.

/** Friendly first-listen model-download size, in whole MB, for user-facing copy. */
export const TTS_MODEL_DOWNLOAD_MB = 90;

/**
 * Exact byte total of the first-listen hub download derived above. The TTS
 * worker floors the denominator of its aggregate download progress with this,
 * so files the hub has not announced yet cannot inflate the percentage (the
 * first few-KB JSON would otherwise read 100% on its own).
 */
export const TTS_MODEL_DOWNLOAD_BYTES = 92_887_010;
