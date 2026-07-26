/**
 * Output cap for the classifier call. Reasoning-class models (e.g.
 * `openai/gpt-5-nano`, the cheapest ZDR text model) spend output tokens on
 * hidden reasoning before emitting the model id, so the cap must cover
 * worst-case reasoning headroom plus the ~10–30-token id. A tight cap yields
 * an empty completion — reasoning consumes the whole budget and no visible
 * text is emitted.
 *
 * This is the single shared home for the cap: the canonical estimator's
 * classifier line-item builder and the workflow's classifier node both import
 * it from here — do not move it.
 */
export const CLASSIFIER_OUTPUT_TOKEN_CAP = 2048;
