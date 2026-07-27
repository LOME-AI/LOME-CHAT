/**
 * The accessibility panel surface, kept out of `@hushbox/ui/accessibility` so
 * that importing the providers cannot drag it in.
 *
 * Importing anything from here pulls the on-device TTS engine into the module
 * graph, and with it the bundler-emitted TTS worker chunk and its ONNX runtime
 * wasm — tens of megabytes. That cost survives tree-shaking: the audio section
 * imports the engine, the engine constructs its worker from a
 * `new Worker(new URL(…, import.meta.url))` specifier, and the bundler resolves
 * and emits that worker at transform time, before anything is shaken out.
 * Emitted assets are never collected again, so the bytes ship even when every
 * symbol reaching them is dead. An app that does not want them must import only
 * `@hushbox/ui/accessibility`, whose closure never reaches the engine; the
 * build-time bundle verifier fails any app that declares itself TTS-free and
 * picks these assets up anyway.
 *
 * The widget is a Sheet wrapper around the panel, so the two always ship
 * together and are exported together.
 */
export { AccessibilityWidget } from '../accessibility-widget';
export { AccessibilityPanel } from '../accessibility-panel';
