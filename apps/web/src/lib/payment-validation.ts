import { MIN_DEPOSIT_USD } from '@hushbox/shared';
import { validateCardNumber, validateExpiry, validateCvv, validateZip } from './card-utilities.js';

export const MIN_DEPOSIT_AMOUNT = MIN_DEPOSIT_USD;
export const MAX_DEPOSIT_AMOUNT = 1000;
export const MIN_NAME_LENGTH = 2;
export const MIN_ADDRESS_LENGTH = 5;

export interface AmountValidation {
  isValid: boolean;
  error?: string;
  success?: string;
}

export interface CardFields {
  cardNumber: string;
  expiry: string;
  cvv: string;
  cardHolderName: string;
  billingAddress: string;
  zipCode: string;
}

export interface CardTouchedState {
  cardNumber: boolean;
  expiry: boolean;
  cvv: boolean;
  cardHolderName: boolean;
  billingAddress: boolean;
  zipCode: boolean;
}

export interface FieldValidationState {
  error: string | null;
  success?: string | undefined;
}

export interface CardValidationState {
  cardNumber: FieldValidationState;
  expiry: FieldValidationState;
  cvv: FieldValidationState;
  cardHolderName: FieldValidationState;
  billingAddress: FieldValidationState;
  zipCode: FieldValidationState;
}

export function validateAmount(value: string): AmountValidation {
  if (!value) {
    return { isValid: false, error: 'Please enter an amount' };
  }

  const numberValue = Number.parseFloat(value);
  if (Number.isNaN(numberValue)) {
    return { isValid: false, error: 'Please enter a valid amount' };
  }

  const decimalIndex = value.indexOf('.');
  if (decimalIndex !== -1 && value.length - decimalIndex - 1 > 2) {
    return { isValid: false, error: 'Amount cannot have more than 2 decimal places' };
  }

  if (numberValue < MIN_DEPOSIT_AMOUNT) {
    return { isValid: false, error: `Minimum deposit is $${String(MIN_DEPOSIT_AMOUNT)}` };
  }

  if (numberValue > MAX_DEPOSIT_AMOUNT) {
    return { isValid: false, error: `Maximum deposit is $${String(MAX_DEPOSIT_AMOUNT)}` };
  }

  return { isValid: true, success: 'Valid amount' };
}

export function validateCardHolderName(name: string): string | null {
  if (!name || name.trim().length === 0) return 'Name is required';
  if (name.trim().length < MIN_NAME_LENGTH) return 'Name is too short';
  if (!/^[a-zA-Z\s\-'.]+$/.test(name)) return 'Name contains invalid characters';
  return null;
}

export function validateBillingAddress(address: string): string | null {
  if (!address || address.trim().length === 0) return 'Address is required';
  if (address.trim().length < MIN_ADDRESS_LENGTH) return 'Address is too short';
  return null;
}

function getFieldValidation(
  value: string,
  touched: boolean,
  validate: (v: string) => string | null,
  successMessage: string
): FieldValidationState {
  if (!touched) {
    return { error: null, success: undefined };
  }
  const error = validate(value);
  return {
    error,
    success: error === null && value.length > 0 ? successMessage : undefined,
  };
}

export function getCardValidationState(
  fields: CardFields,
  touched: CardTouchedState
): CardValidationState {
  return {
    cardNumber: getFieldValidation(
      fields.cardNumber,
      touched.cardNumber,
      validateCardNumber,
      'Valid card'
    ),
    expiry: getFieldValidation(fields.expiry, touched.expiry, validateExpiry, 'Valid expiry'),
    cvv: getFieldValidation(fields.cvv, touched.cvv, validateCvv, 'Valid CVV'),
    cardHolderName: getFieldValidation(
      fields.cardHolderName,
      touched.cardHolderName,
      validateCardHolderName,
      'Valid name'
    ),
    billingAddress: getFieldValidation(
      fields.billingAddress,
      touched.billingAddress,
      validateBillingAddress,
      'Valid address'
    ),
    zipCode: getFieldValidation(fields.zipCode, touched.zipCode, validateZip, 'Valid ZIP'),
  };
}

export function validateAllCardFields(fields: CardFields): boolean {
  const errors = {
    cardNumber: validateCardNumber(fields.cardNumber),
    expiry: validateExpiry(fields.expiry),
    cvv: validateCvv(fields.cvv),
    cardHolderName: validateCardHolderName(fields.cardHolderName),
    billingAddress: validateBillingAddress(fields.billingAddress),
    zipCode: validateZip(fields.zipCode),
  };

  return (
    !errors.cardNumber &&
    !errors.expiry &&
    !errors.cvv &&
    !errors.cardHolderName &&
    !errors.billingAddress &&
    !errors.zipCode
  );
}
