/**
 * Mock Helcim.js for local development.
 * Simulates card tokenization by populating the same DOM elements
 * that the real Helcim.js script would populate.
 */

export const MOCK_TEST_CARDS = {
  SUCCESS: {
    number: '4111111111111111',
    cvv: '123',
    expiry: '12/28',
    type: 'Visa',
    lastFour: '1111',
  },
  DECLINE: {
    cvv: '200',
  },
} as const;

function setElementValue(id: string, value: string): void {
  const el = document.querySelector<HTMLInputElement>(`#${id}`);
  if (el) {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function getElementValue(id: string): string {
  const el = document.querySelector<HTMLInputElement>(`#${id}`);
  return el?.value ?? '';
}

function mockHelcimProcess(): void {
  const cardNumber = getElementValue('cardNumber');
  const cvv = getElementValue('cardCVV');

  if (!cardNumber) {
    setElementValue('response', '0');
    setElementValue('responseMessage', 'Card number required');
    return;
  }

  if (cvv === MOCK_TEST_CARDS.DECLINE.cvv) {
    setElementValue('response', '0');
    setElementValue('responseMessage', 'Card declined');
    return;
  }

  const token = `mock-token-${crypto.randomUUID()}`;
  const customerCode = `mock-customer-${crypto.randomUUID()}`;
  const firstFour = cardNumber.slice(0, 4);
  const lastFour = cardNumber.slice(-4);

  setElementValue('response', '1');
  setElementValue('responseMessage', '');
  setElementValue('cardToken', token);
  setElementValue('customerCode', customerCode);
  setElementValue('cardType', 'Visa');
  // Helcim's cardF4L4 is the first four followed by the last four digits; the
  // loader reads the displayed last-four via `.slice(-4)`.
  setElementValue('cardF4L4', `${firstFour}${lastFour}`);
}

export function installMockHelcim(): void {
  globalThis.helcimProcess = mockHelcimProcess;
}

export function uninstallMockHelcim(): void {
  globalThis.helcimProcess = undefined;
}
