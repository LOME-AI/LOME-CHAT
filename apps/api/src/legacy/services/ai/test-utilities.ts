/**
 * Barrel for integration-test utilities. Each concern lives in its own file:
 *   - `integration-setup.ts` — `setupIntegrationClient`, env-aware client wiring
 *   - `test-model-picker.ts` — `getCheapestTestModel`, capability-driven picker
 *   - `stream-consumer.ts` — `consumeStream`, drain InferenceStream
 *   - `media-assertions.ts` — `assertValidMediaBytes`, magic-byte validators
 *
 * Consumers can import from this barrel or from the specific module; both
 * paths resolve to the same exports.
 */

export { setupIntegrationClient, type IntegrationClientSetup } from './integration-setup.js';
export {
  getCheapestTestModel,
  clearTestModelCache,
  type ImageTestParameters,
  type TestModelSpec,
  type TestParameters,
  type TextTestParameters,
  type VideoTestParameters,
} from './test-model-picker.js';
export { consumeStream, type ConsumedStream } from './stream-consumer.js';
export { assertValidMediaBytes, type MediaSizeBounds } from './media-assertions.js';
