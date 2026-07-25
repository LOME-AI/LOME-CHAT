import { registerServiceWorkerListeners } from './register-listeners.js';
import type { ServiceWorkerScope } from './handlers.js';

// Entry compiled to a stable, unhashed `/sw.js`. `globalThis` is the service
// worker global scope at runtime; it is typed here as the narrow push-only
// surface the worker actually uses.
registerServiceWorkerListeners(globalThis as unknown as ServiceWorkerScope);
