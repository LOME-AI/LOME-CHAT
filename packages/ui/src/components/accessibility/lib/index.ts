export * from './colorblind-matrices';
export { SvgColorblindDefs } from './svg-colorblind-defs';
export { applySettings } from './apply-settings';
export { A11Y_INIT_SCRIPT } from './init-script';
export { activateFont, _resetFontLoaderForTesting } from './font-loader';
export { installMutePauser } from './mute';
export { installMediaPauser } from './media-pauser';
export { installReducedMotionClass } from './reduced-motion-broadcaster';
export { MotionProvider } from './motion-provider';
export {
  ACCESSIBILITY_PROFILES,
  getProfile,
  type AccessibilityProfile,
  type ProfileId,
} from './profiles';
export {
  getTtsService,
  _resetTtsServiceForTesting,
  TTS_VOICES,
  type TtsService,
  type TtsVoice,
  type TtsVoiceMeta,
} from './tts-engine';
export { SentenceChunker } from './sentence-chunker';
export {
  createDocumentReader,
  type DocumentReader,
  type DocumentReaderState,
  type DocumentReaderChunk,
  type CreateDocumentReaderOptions,
} from './document-reader';
export {
  createChunkHighlighter,
  type ChunkHighlighter,
  type ChunkHighlightTarget,
} from './chunk-highlighter';
export {
  createTtsStreamFeeder,
  type TtsStreamFeeder,
  type CreateTtsStreamFeederOptions,
} from './tts-stream-feeder';
