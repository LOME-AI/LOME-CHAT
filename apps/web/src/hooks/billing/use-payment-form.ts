import { useState, useCallback, useMemo } from 'react';
import { formatCardNumber, formatExpiry, formatCvv, formatZip } from '@/lib/card-utilities.js';
import {
  validateAmount,
  getCardValidationState,
  validateAllCardFields,
  type AmountValidation,
  type CardFields,
  type CardTouchedState,
  type CardValidationState,
} from '@/lib/payment-validation.js';

// Formatter config - auto-applied based on field name
const FIELD_FORMATTERS: Partial<Record<keyof CardFields, (v: string) => string>> = {
  cardNumber: formatCardNumber,
  expiry: formatExpiry,
  cvv: formatCvv,
  zipCode: formatZip,
  // cardHolderName and billingAddress have no formatter (pass-through)
};

const INITIAL_CARD_FIELDS: CardFields = {
  cardNumber: '',
  expiry: '',
  cvv: '',
  cardHolderName: '',
  billingAddress: '',
  zipCode: '',
};

const INITIAL_TOUCHED_STATE: CardTouchedState = {
  cardNumber: false,
  expiry: false,
  cvv: false,
  cardHolderName: false,
  billingAddress: false,
  zipCode: false,
};

interface UsePaymentFormReturn {
  // Values
  amount: string;
  cardFields: CardFields;

  // Touched state
  amountTouched: boolean;
  cardTouched: CardTouchedState;

  // Validation state
  amountValidation: AmountValidation;
  cardValidation: CardValidationState;

  // Handlers
  handleAmountChange: (value: string) => void;
  handleFieldChange: (field: keyof CardFields, value: string) => void;

  // Actions
  touchAllFields: () => void;
  validateAll: () => boolean;
  reset: () => void;

  // Computed values
  expiryParts: { month: string; year: string };
}

/**
 * Hook for managing payment form state, validation, and handlers.
 */
export function usePaymentForm(): UsePaymentFormReturn {
  // Amount state
  const [amount, setAmount] = useState('');
  const [amountTouched, setAmountTouched] = useState(false);

  // Card fields as single state object
  const [cardFields, setCardFields] = useState<CardFields>(INITIAL_CARD_FIELDS);
  const [cardTouched, setCardTouched] = useState<CardTouchedState>(INITIAL_TOUCHED_STATE);

  // Computed expiry parts for Helcim hidden fields
  const expiryParts = useMemo(() => {
    const parts = cardFields.expiry.split(' / ');
    return {
      /* v8 ignore start -- String.split always returns at least one element, so parts[0] is never undefined; the ?? '' only satisfies noUncheckedIndexedAccess */
      month: parts[0] ?? '',
      /* v8 ignore stop */
      year: parts[1] ?? '',
    };
  }, [cardFields.expiry]);

  // Computed validation state
  const amountValidation = useMemo<AmountValidation>(
    () => (amountTouched ? validateAmount(amount) : { isValid: false }),
    [amount, amountTouched]
  );

  const cardValidation = useMemo<CardValidationState>(
    () => getCardValidationState(cardFields, cardTouched),
    [cardFields, cardTouched]
  );

  // Amount handler
  const handleAmountChange = useCallback((value: string) => {
    setAmount(value);
    setAmountTouched(true);
  }, []);

  // Generic field handler - ONE handler for ALL card fields
  const handleFieldChange = useCallback((field: keyof CardFields, value: string) => {
    const formatter = FIELD_FORMATTERS[field];
    const formattedValue = formatter ? formatter(value) : value;

    setCardFields((previous) => ({ ...previous, [field]: formattedValue }));
    setCardTouched((previous) => ({ ...previous, [field]: true }));
  }, []);

  // Touch all fields (for form submission)
  const touchAllFields = useCallback(() => {
    setAmountTouched(true);
    setCardTouched({
      cardNumber: true,
      expiry: true,
      cvv: true,
      cardHolderName: true,
      billingAddress: true,
      zipCode: true,
    });
  }, []);

  // Validate all and return result
  const validateAll = useCallback((): boolean => {
    touchAllFields();

    const amountResult = validateAmount(amount);
    const cardResult = validateAllCardFields(cardFields);

    return amountResult.isValid && cardResult;
  }, [amount, cardFields, touchAllFields]);

  // Reset form
  const reset = useCallback(() => {
    setAmount('');
    setAmountTouched(false);
    setCardFields(INITIAL_CARD_FIELDS);
    setCardTouched(INITIAL_TOUCHED_STATE);
  }, []);

  return {
    // Values
    amount,
    cardFields,

    // Touched state
    amountTouched,
    cardTouched,

    // Validation state
    amountValidation,
    cardValidation,

    // Handlers
    handleAmountChange,
    handleFieldChange,

    // Actions
    touchAllFields,
    validateAll,
    reset,

    // Computed values
    expiryParts,
  };
}
