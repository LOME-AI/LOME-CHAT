import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loadHelcimScript,
  resetHelcimLoader,
  isHelcimScriptLoaded,
  readHelcimResult,
  tokenizeWithHelcim,
} from './helcim-loader';
import * as helcimMock from './helcim-mock';

describe('helcim-loader', () => {
  beforeEach(() => {
    resetHelcimLoader();
    document.head.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loadHelcimScript', () => {
    it('creates a script element with correct src', async () => {
      const createElementSpy = vi.spyOn(document, 'createElement');

      const promise = loadHelcimScript();

      const scripts = document.head.querySelectorAll('script');
      expect(scripts).toHaveLength(1);
      expect(scripts[0]?.src).toBe('https://secure.myhelcim.com/js/version2.js');
      expect(scripts[0]?.async).toBe(true);

      scripts[0]?.dispatchEvent(new Event('load'));
      await promise;

      expect(createElementSpy).toHaveBeenCalledWith('script');
    });

    it('resolves when script loads successfully', async () => {
      const promise = loadHelcimScript();

      const script = document.head.querySelector('script');
      script?.dispatchEvent(new Event('load'));

      await expect(promise).resolves.toBeUndefined();
    });

    it('rejects when script fails to load', async () => {
      const promise = loadHelcimScript();

      const script = document.head.querySelector('script');
      script?.dispatchEvent(new Event('error'));

      await expect(promise).rejects.toThrow('Failed to load Helcim script');
    });

    it('returns same promise when called multiple times before load', async () => {
      const promise1 = loadHelcimScript();
      const promise2 = loadHelcimScript();

      expect(promise1).toBe(promise2);

      const scripts = document.head.querySelectorAll('script');
      expect(scripts).toHaveLength(1);

      scripts[0]?.dispatchEvent(new Event('load'));
      await promise1;
    });

    it('returns immediately if already loaded', async () => {
      const promise1 = loadHelcimScript();
      const script = document.head.querySelector('script');
      script?.dispatchEvent(new Event('load'));
      await promise1;

      const promise2 = loadHelcimScript();
      await expect(promise2).resolves.toBeUndefined();

      const scripts = document.head.querySelectorAll('script');
      expect(scripts).toHaveLength(1);
    });

    it('allows retry after error', async () => {
      const promise1 = loadHelcimScript();
      let script = document.head.querySelector('script');
      script?.dispatchEvent(new Event('error'));

      await expect(promise1).rejects.toThrow();

      document.head.innerHTML = '';

      const promise2 = loadHelcimScript();
      script = document.head.querySelector('script');
      script?.dispatchEvent(new Event('load'));

      await expect(promise2).resolves.toBeUndefined();
    });
  });

  describe('isHelcimScriptLoaded', () => {
    it('returns false initially', () => {
      expect(isHelcimScriptLoaded()).toBe(false);
    });

    it('returns true after script loads', async () => {
      const promise = loadHelcimScript();
      const script = document.head.querySelector('script');
      script?.dispatchEvent(new Event('load'));
      await promise;

      expect(isHelcimScriptLoaded()).toBe(true);
    });

    it('returns false after reset', async () => {
      const promise = loadHelcimScript();
      const script = document.head.querySelector('script');
      script?.dispatchEvent(new Event('load'));
      await promise;

      resetHelcimLoader();

      expect(isHelcimScriptLoaded()).toBe(false);
    });
  });

  describe('resetHelcimLoader', () => {
    it('resets loaded state', async () => {
      const promise = loadHelcimScript();
      const script = document.head.querySelector('script');
      script?.dispatchEvent(new Event('load'));
      await promise;

      expect(isHelcimScriptLoaded()).toBe(true);

      resetHelcimLoader();

      expect(isHelcimScriptLoaded()).toBe(false);
    });
  });

  describe('readHelcimResult', () => {
    beforeEach(() => {
      document.body.innerHTML = '';
    });

    it('returns success result when response is 1', () => {
      createMockResultElements({
        response: '1',
        responseMessage: '',
        cardToken: 'token-123',
        cardType: 'Visa',
        cardF4L4: '12349999',
      });

      const result = readHelcimResult();

      expect(result.success).toBe(true);
      expect(result.cardToken).toBe('token-123');
      expect(result.cardType).toBe('Visa');
      expect(result.cardLastFour).toBe('9999');
    });

    it('returns failure result when response is not 1', () => {
      createMockResultElements({
        response: '0',
        responseMessage: 'Card declined',
        cardToken: '',
        cardType: '',
        cardF4L4: '',
      });

      const result = readHelcimResult();

      expect(result.success).toBe(false);
      expect(result.errorMessage).toBe('Card declined');
    });

    it('returns default error message when responseMessage is empty', () => {
      createMockResultElements({
        response: '0',
        responseMessage: '',
        cardToken: '',
        cardType: '',
        cardF4L4: '',
      });

      const result = readHelcimResult();

      expect(result.success).toBe(false);
      expect(result.errorMessage).toBe('Card tokenization failed');
    });

    it('handles missing DOM elements gracefully', () => {
      const result = readHelcimResult();

      expect(result.success).toBe(false);
      expect(result.errorMessage).toBe('Card tokenization failed');
    });

    it('extracts last 4 digits from cardF4L4', () => {
      createMockResultElements({
        response: '1',
        responseMessage: '',
        cardToken: 'token-456',
        cardType: 'MasterCard',
        cardF4L4: '12341234', // First 4 and last 4
      });

      const result = readHelcimResult();

      expect(result.cardLastFour).toBe('1234');
    });
  });

  describe('loadHelcimScript with useMock option', () => {
    afterEach(() => {
      helcimMock.uninstallMockHelcim();
    });

    it('installs mock instead of loading real script when useMock is true', async () => {
      const installSpy = vi.spyOn(helcimMock, 'installMockHelcim');

      await loadHelcimScript({ useMock: true });

      expect(installSpy).toHaveBeenCalled();
      expect(isHelcimScriptLoaded()).toBe(true);
      expect(globalThis.helcimProcess).toBeDefined();
    });

    it('does not create script element when useMock is true', async () => {
      await loadHelcimScript({ useMock: true });

      const scripts = document.head.querySelectorAll('script');
      expect(scripts).toHaveLength(0);
    });
  });

  describe('tokenizeWithHelcim', () => {
    beforeEach(() => {
      document.body.innerHTML = '';
    });

    afterEach(() => {
      globalThis.helcimProcess = undefined;
    });

    it('rejects when helcimProcess is not installed', async () => {
      globalThis.helcimProcess = undefined;

      await expect(tokenizeWithHelcim()).rejects.toThrow('Helcim payment processor not available');
    });

    it('awaits helcimProcess then resolves with the DOM result', async () => {
      globalThis.helcimProcess = vi.fn(() => {
        createMockResultElements({
          response: '1',
          responseMessage: '',
          cardToken: 'token-123',
          cardType: 'Visa',
          cardF4L4: '12349999',
        });
      });

      const result = await tokenizeWithHelcim();

      expect(globalThis.helcimProcess).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.cardToken).toBe('token-123');
      expect(result.cardLastFour).toBe('9999');
    });

    it('reads the result only after a promise-returning helcimProcess resolves', async () => {
      // Real Helcim.js v2 returns a Promise that resolves only after it has
      // written the result fields into the DOM; the read must come after.
      globalThis.helcimProcess = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              createMockResultElements({
                response: '1',
                responseMessage: '',
                cardToken: 'token-async',
                cardType: 'Visa',
                cardF4L4: '12349999',
              });
              resolve();
            }, 0);
          })
      );

      const result = await tokenizeWithHelcim();

      expect(result.success).toBe(true);
      expect(result.cardToken).toBe('token-async');
    });

    it('returns a failure result when helcimProcess rejects with a string', async () => {
      // Real Helcim.js v2 rejects with a plain-text error string on
      // validation and communication failures — a string, never an Error.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- pinning the real Helcim.js string-rejection contract
      globalThis.helcimProcess = vi.fn(() => Promise.reject('ERROR: (token)'));

      const result = await tokenizeWithHelcim();

      expect(result.success).toBe(false);
      expect(result.errorMessage).toBe('ERROR: (token)');
    });

    it('returns the generic failure message when helcimProcess rejects with an empty string', async () => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- pinning the real Helcim.js string-rejection contract
      globalThis.helcimProcess = vi.fn(() => Promise.reject(''));

      const result = await tokenizeWithHelcim();

      expect(result.success).toBe(false);
      expect(result.errorMessage).toBe('Card tokenization failed');
    });

    it('rethrows when helcimProcess rejects with a non-string error', async () => {
      globalThis.helcimProcess = vi.fn(() => Promise.reject(new Error('trigger defect')));

      await expect(tokenizeWithHelcim()).rejects.toThrow('trigger defect');
    });
  });
});

function createMockResultElements(values: {
  response: string;
  responseMessage: string;
  cardToken: string;
  cardType: string;
  cardF4L4: string;
}): void {
  const elements = [
    { id: 'response', value: values.response },
    { id: 'responseMessage', value: values.responseMessage },
    { id: 'cardToken', value: values.cardToken },
    { id: 'cardType', value: values.cardType },
    { id: 'cardF4L4', value: values.cardF4L4 },
  ];

  for (const { id, value } of elements) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.id = id;
    input.value = value;
    document.body.append(input);
  }
}
