import type { VersionPins } from './specifier.js';

/**
 * The React version the renderer injects for react documents. Authors never
 * name React themselves (the automatic JSX runtime imports it), so the renderer
 * pins one build; `react` and `react-dom` must resolve to the same version or
 * the runtime and the reconciler disagree. Test-mode stub modules are named
 * with this exact version so a document's `react` import resolves to them.
 */
export const REACT_RUNTIME_VERSION = '19.1.0';

/** Version pins the renderer applies to the React family of packages. */
export const REACT_PINS: VersionPins = {
  react: REACT_RUNTIME_VERSION,
  'react-dom': REACT_RUNTIME_VERSION,
};
