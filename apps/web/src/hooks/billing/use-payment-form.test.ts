import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePaymentForm } from '@/hooks/billing/use-payment-form.js';

describe('usePaymentForm', () => {
  describe('initial state', () => {
    it('initializes with empty values', () => {
      const { result } = renderHook(() => usePaymentForm());

      expect(result.current.amount).toBe('');
      expect(result.current.cardFields.cardNumber).toBe('');
      expect(result.current.cardFields.expiry).toBe('');
      expect(result.current.cardFields.cvv).toBe('');
      expect(result.current.cardFields.cardHolderName).toBe('');
      expect(result.current.cardFields.billingAddress).toBe('');
      expect(result.current.cardFields.zipCode).toBe('');
    });

    it('initializes with untouched state', () => {
      const { result } = renderHook(() => usePaymentForm());

      expect(result.current.amountTouched).toBe(false);
      expect(result.current.cardTouched.cardNumber).toBe(false);
      expect(result.current.cardTouched.expiry).toBe(false);
      expect(result.current.cardTouched.cvv).toBe(false);
      expect(result.current.cardTouched.cardHolderName).toBe(false);
      expect(result.current.cardTouched.billingAddress).toBe(false);
      expect(result.current.cardTouched.zipCode).toBe(false);
    });

    it('has no validation errors initially', () => {
      const { result } = renderHook(() => usePaymentForm());

      expect(result.current.amountValidation.isValid).toBe(false);
      expect(result.current.amountValidation.error).toBeUndefined();
      expect(result.current.cardValidation.cardNumber.error).toBeNull();
      expect(result.current.cardValidation.expiry.error).toBeNull();
      expect(result.current.cardValidation.cvv.error).toBeNull();
      expect(result.current.cardValidation.cardHolderName.error).toBeNull();
      expect(result.current.cardValidation.billingAddress.error).toBeNull();
      expect(result.current.cardValidation.zipCode.error).toBeNull();
    });
  });

  describe('amount handling', () => {
    it('updates amount value', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleAmountChange('50');
      });

      expect(result.current.amount).toBe('50');
    });

    it('marks amount as touched on change', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleAmountChange('50');
      });

      expect(result.current.amountTouched).toBe(true);
    });

    it('validates amount after touch', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleAmountChange('50');
      });

      expect(result.current.amountValidation.isValid).toBe(true);
      expect(result.current.amountValidation.success).toBe('Valid amount');
    });

    it('shows error for invalid amount', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleAmountChange('2');
      });

      expect(result.current.amountValidation.isValid).toBe(false);
      expect(result.current.amountValidation.error).toBe('Minimum deposit is $5');
    });
  });

  describe('handleFieldChange', () => {
    it('updates and formats card number', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleFieldChange('cardNumber', '4111111111111111');
      });

      expect(result.current.cardFields.cardNumber).toBe('4111 1111 1111 1111');
    });

    it('marks card number as touched', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleFieldChange('cardNumber', '4111');
      });

      expect(result.current.cardTouched.cardNumber).toBe(true);
    });

    it('validates valid card number', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleFieldChange('cardNumber', '4111111111111111');
      });

      expect(result.current.cardValidation.cardNumber.error).toBeNull();
      expect(result.current.cardValidation.cardNumber.success).toBe('Valid card');
    });

    it('updates and formats expiry', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleFieldChange('expiry', '1230');
      });

      expect(result.current.cardFields.expiry).toBe('12 / 30');
    });

    it('marks expiry as touched', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleFieldChange('expiry', '12');
      });

      expect(result.current.cardTouched.expiry).toBe(true);
    });

    it('falls back to an empty year when the expiry has no separator yet', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleFieldChange('expiry', '1');
      });

      // A single-digit month has no ' / ' delimiter, so the split yields no
      // second part and the year computes to '' rather than undefined.
      expect(result.current.expiryParts.month).toBe('1');
      expect(result.current.expiryParts.year).toBe('');
    });

    it('updates and formats CVV', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleFieldChange('cvv', '1234');
      });

      expect(result.current.cardFields.cvv).toBe('1234');
    });

    it('marks CVV as touched', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleFieldChange('cvv', '123');
      });

      expect(result.current.cardTouched.cvv).toBe(true);
    });

    it('updates cardholder name without formatting', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleFieldChange('cardHolderName', 'John Smith');
      });

      expect(result.current.cardFields.cardHolderName).toBe('John Smith');
    });

    it('marks cardholder name as touched', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleFieldChange('cardHolderName', 'John');
      });

      expect(result.current.cardTouched.cardHolderName).toBe(true);
    });

    it('validates valid cardholder name', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleFieldChange('cardHolderName', 'John Smith');
      });

      expect(result.current.cardValidation.cardHolderName.error).toBeNull();
      expect(result.current.cardValidation.cardHolderName.success).toBe('Valid name');
    });

    it('shows error for invalid cardholder name', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleFieldChange('cardHolderName', 'A');
      });

      expect(result.current.cardValidation.cardHolderName.error).toBe('Name is too short');
    });

    it('updates billing address without formatting', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleFieldChange('billingAddress', '123 Main Street');
      });

      expect(result.current.cardFields.billingAddress).toBe('123 Main Street');
    });

    it('marks billing address as touched', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleFieldChange('billingAddress', '123');
      });

      expect(result.current.cardTouched.billingAddress).toBe(true);
    });

    it('validates valid billing address', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleFieldChange('billingAddress', '123 Main Street');
      });

      expect(result.current.cardValidation.billingAddress.error).toBeNull();
      expect(result.current.cardValidation.billingAddress.success).toBe('Valid address');
    });

    it('shows error for invalid billing address', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleFieldChange('billingAddress', '123');
      });

      expect(result.current.cardValidation.billingAddress.error).toBe('Address is too short');
    });

    it('updates and formats ZIP code', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleFieldChange('zipCode', '12345');
      });

      expect(result.current.cardFields.zipCode).toBe('12345');
    });

    it('marks ZIP code as touched', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleFieldChange('zipCode', '12345');
      });

      expect(result.current.cardTouched.zipCode).toBe(true);
    });
  });

  describe('touchAllFields', () => {
    it('marks all fields as touched', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.touchAllFields();
      });

      expect(result.current.amountTouched).toBe(true);
      expect(result.current.cardTouched.cardNumber).toBe(true);
      expect(result.current.cardTouched.expiry).toBe(true);
      expect(result.current.cardTouched.cvv).toBe(true);
      expect(result.current.cardTouched.cardHolderName).toBe(true);
      expect(result.current.cardTouched.billingAddress).toBe(true);
      expect(result.current.cardTouched.zipCode).toBe(true);
    });
  });

  describe('validateAll', () => {
    it('returns false when form is empty', () => {
      const { result } = renderHook(() => usePaymentForm());

      let isValid = false;
      act(() => {
        isValid = result.current.validateAll();
      });

      expect(isValid).toBe(false);
    });

    it('returns false when only amount is valid', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleAmountChange('50');
      });

      let isValid = false;
      act(() => {
        isValid = result.current.validateAll();
      });

      expect(isValid).toBe(false);
    });

    it('returns true when all fields are valid', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleAmountChange('50');
        result.current.handleFieldChange('cardNumber', '4111111111111111');
        result.current.handleFieldChange('expiry', '1230');
        result.current.handleFieldChange('cvv', '123');
        result.current.handleFieldChange('cardHolderName', 'John Smith');
        result.current.handleFieldChange('billingAddress', '123 Main Street');
        result.current.handleFieldChange('zipCode', '12345');
      });

      let isValid = false;
      act(() => {
        isValid = result.current.validateAll();
      });

      expect(isValid).toBe(true);
    });

    it('touches all fields when validating', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.validateAll();
      });

      expect(result.current.amountTouched).toBe(true);
      expect(result.current.cardTouched.cardNumber).toBe(true);
      expect(result.current.cardTouched.cardHolderName).toBe(true);
      expect(result.current.cardTouched.billingAddress).toBe(true);
    });
  });

  describe('reset', () => {
    it('resets all values to initial state', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleAmountChange('50');
        result.current.handleFieldChange('cardNumber', '4111111111111111');
        result.current.handleFieldChange('expiry', '1230');
        result.current.handleFieldChange('cvv', '123');
        result.current.handleFieldChange('cardHolderName', 'John Smith');
        result.current.handleFieldChange('billingAddress', '123 Main Street');
        result.current.handleFieldChange('zipCode', '12345');
      });

      act(() => {
        result.current.reset();
      });

      expect(result.current.amount).toBe('');
      expect(result.current.cardFields.cardNumber).toBe('');
      expect(result.current.cardFields.expiry).toBe('');
      expect(result.current.cardFields.cvv).toBe('');
      expect(result.current.cardFields.cardHolderName).toBe('');
      expect(result.current.cardFields.billingAddress).toBe('');
      expect(result.current.cardFields.zipCode).toBe('');
    });

    it('resets touched state', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleAmountChange('50');
        result.current.handleFieldChange('cardHolderName', 'John');
      });

      act(() => {
        result.current.reset();
      });

      expect(result.current.amountTouched).toBe(false);
      expect(result.current.cardTouched.cardNumber).toBe(false);
      expect(result.current.cardTouched.cardHolderName).toBe(false);
      expect(result.current.cardTouched.billingAddress).toBe(false);
    });
  });

  describe('cardFields getter', () => {
    it('returns all card fields', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleFieldChange('cardNumber', '4111111111111111');
        result.current.handleFieldChange('expiry', '1230');
        result.current.handleFieldChange('cvv', '123');
        result.current.handleFieldChange('cardHolderName', 'John Smith');
        result.current.handleFieldChange('billingAddress', '123 Main Street');
        result.current.handleFieldChange('zipCode', '12345');
      });

      expect(result.current.cardFields).toEqual({
        cardNumber: '4111 1111 1111 1111',
        expiry: '12 / 30',
        cvv: '123',
        cardHolderName: 'John Smith',
        billingAddress: '123 Main Street',
        zipCode: '12345',
      });
    });
  });

  describe('expiryParts getter', () => {
    it('returns month and year from expiry', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleFieldChange('expiry', '1230');
      });

      expect(result.current.expiryParts).toEqual({ month: '12', year: '30' });
    });

    it('returns empty strings for invalid expiry', () => {
      const { result } = renderHook(() => usePaymentForm());

      expect(result.current.expiryParts).toEqual({ month: '', year: '' });
    });
  });
});
