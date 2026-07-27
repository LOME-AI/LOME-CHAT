/**
 * The light accessibility surface: the providers and the SVG filter defs, none
 * of which reach the TTS engine. The panel and the floating widget live behind
 * `@hushbox/ui/accessibility/panel` instead, because their graph carries the
 * speech engine's worker and runtime assets; keeping them out of this barrel is
 * what lets an app mount the providers without paying for them.
 */
export { A11yProvider } from './a11y-provider';
export { SvgColorblindDefs } from './lib/svg-colorblind-defs';
export { MotionProvider } from './lib/motion-provider';
