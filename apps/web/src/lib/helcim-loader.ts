import { installMockHelcim } from './helcim-mock.js';

declare global {
  // Real Helcim.js v2's helcimProcess() returns a Promise that settles when
  // tokenization completes; the local mock writes synchronously and returns
  // undefined. `unknown` covers both (awaited uniformly in tokenizeWithHelcim).
  // This is the program-wide declaration — do not redeclare.
  interface Window {
    helcimProcess?: () => unknown;
  }
  var helcimProcess: (() => unknown) | undefined;
}

const HELCIM_SCRIPT_URL = 'https://secure.myhelcim.com/js/version2.js';

let loadPromise: Promise<void> | null = null;
let isLoaded = false;

export interface LoadHelcimScriptOptions {
  useMock?: boolean;
}

/**
 * Loads the Helcim.js script for client-side card tokenization.
 * Uses singleton pattern to avoid loading the script multiple times.
 *
 * @param options.useMock - If true, installs mock instead of loading real script
 * @returns Promise that resolves when the script is loaded
 */
export function loadHelcimScript(options?: LoadHelcimScriptOptions): Promise<void> {
  if (isLoaded) {
    return Promise.resolve();
  }

  if (options?.useMock) {
    installMockHelcim();
    isLoaded = true;
    return Promise.resolve();
  }

  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = HELCIM_SCRIPT_URL;
    script.async = true;
    script.addEventListener('load', (): void => {
      isLoaded = true;
      resolve();
    });
    script.addEventListener('error', (): void => {
      loadPromise = null;
      reject(new Error('Failed to load Helcim script'));
    });
    document.head.append(script);
  });

  return loadPromise;
}

/**
 * Resets the loader state. For testing purposes only.
 */
export function resetHelcimLoader(): void {
  loadPromise = null;
  isLoaded = false;
}

export function isHelcimScriptLoaded(): boolean {
  return isLoaded;
}

export interface HelcimTokenResult {
  success: boolean;
  cardToken?: string | undefined;
  cardType?: string | undefined;
  cardLastFour?: string | undefined;
  customerCode?: string | undefined;
  errorMessage?: string | undefined;
}

/**
 * Reads the Helcim tokenization result from the DOM.
 * Helcim.js populates hidden input fields in a div with id="helcimResults".
 */
export function readHelcimResult(): HelcimTokenResult {
  const responseEl = document.querySelector<HTMLInputElement>('#response');
  const responseMessageEl = document.querySelector<HTMLInputElement>('#responseMessage');
  const cardTokenEl = document.querySelector<HTMLInputElement>('#cardToken');
  const cardTypeEl = document.querySelector<HTMLInputElement>('#cardType');
  const cardF4L4El = document.querySelector<HTMLInputElement>('#cardF4L4');
  const customerCodeEl = document.querySelector<HTMLInputElement>('#customerCode');

  const response = responseEl?.value;
  const responseMessage = responseMessageEl?.value;
  const cardToken = cardTokenEl?.value;
  const cardType = cardTypeEl?.value;
  const cardF4L4 = cardF4L4El?.value;
  const customerCode = customerCodeEl?.value;

  if (response === '1') {
    return {
      success: true,
      cardToken,
      cardType,
      cardLastFour: cardF4L4?.slice(-4),
      customerCode,
    };
  }

  return {
    success: false,
    // Use || instead of ?? to handle empty strings as well as null/undefined
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- need falsy check for empty string
    errorMessage: responseMessage || 'Card tokenization failed',
  };
}

/**
 * The typed tokenization-complete contract over both tokenizer paths.
 *
 * Real Helcim.js v2's helcimProcess() returns a Promise that settles only
 * after it has written the result fields into #helcimResults (resolve), or
 * replaced the pane with a plain-text error string (reject with that string);
 * the local mock writes the result fields synchronously and returns void.
 * Awaiting the call and then reading the DOM is therefore the one contract
 * both genuinely satisfy — unlike MutationObserver on #helcimResults, which
 * the mock's `.value` property writes never fire in a real browser.
 *
 * A string rejection is a completed-with-failure tokenization (Helcim's
 * validation/communication errors); anything else thrown is a trigger defect
 * and propagates to the caller.
 */
export async function tokenizeWithHelcim(): Promise<HelcimTokenResult> {
  const process = globalThis.helcimProcess;
  if (!process) {
    throw new Error('Helcim payment processor not available');
  }

  try {
    await process();
  } catch (error) {
    if (typeof error === 'string') {
      return {
        success: false,
        errorMessage: error === '' ? 'Card tokenization failed' : error,
      };
    }
    throw error;
  }

  return readHelcimResult();
}
