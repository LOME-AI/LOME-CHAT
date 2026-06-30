import { describe, it, expect } from 'vitest';
import {
  legacyErrorResponseSchema,
  type LegacyErrorResponse,
  ERROR_CODE_UNAUTHORIZED,
  ERROR_CODE_NOT_FOUND,
  ERROR_CODE_VALIDATION,
  ERROR_CODE_INSUFFICIENT_BALANCE,
  ERROR_CODE_RATE_LIMITED,
  ERROR_CODE_INTERNAL,
  ERROR_CODE_FORBIDDEN,
  ERROR_CODE_PAYMENT_REQUIRED,
  ERROR_CODE_CONFLICT,
  ERROR_CODE_INVALID_OPERATION,
  ERROR_CODE_EXPIRED,
  ERROR_CODE_SERVICE_UNAVAILABLE,
  ERROR_CODE_BILLING_MISMATCH,
  ERROR_CODE_CSRF_REJECTED,
  ERROR_CODE_SESSION_REVOKED,
  ERROR_CODE_PASSWORD_CHANGED,
  ERROR_CODE_AUTH_FAILED,
  ERROR_CODE_LOGIN_FAILED,
  ERROR_CODE_LOGIN_INIT_FAILED,
  ERROR_CODE_REGISTRATION_FAILED,
  ERROR_CODE_USER_CREATION_FAILED,
  ERROR_CODE_ENCRYPTION_NOT_SETUP,
  ERROR_CODE_EMAIL_NOT_VERIFIED,
  ERROR_CODE_NOT_AUTHENTICATED,
  ERROR_CODE_NO_PENDING_LOGIN,
  ERROR_CODE_NO_PENDING_REGISTRATION,
  ERROR_CODE_NO_PENDING_CHANGE,
  ERROR_CODE_NO_PENDING_RECOVERY,
  ERROR_CODE_INCORRECT_PASSWORD,
  ERROR_CODE_CHANGE_PASSWORD_FAILED,
  ERROR_CODE_CHANGE_PASSWORD_INIT_FAILED,
  ERROR_CODE_CHANGE_PASSWORD_REG_FAILED,
  ERROR_CODE_ACCOUNT_KEY_NOT_AVAILABLE,
  ERROR_CODE_VERIFICATION_FAILED,
  ERROR_CODE_INVALID_OR_EXPIRED_TOKEN,
  ERROR_CODE_2FA_VERIFICATION_FAILED,
  ERROR_CODE_2FA_REQUIRED,
  ERROR_CODE_2FA_EXPIRED,
  ERROR_CODE_INVALID_TOTP_CODE,
  ERROR_CODE_TOTP_NOT_CONFIGURED,
  ERROR_CODE_TOTP_NOT_ENABLED,
  ERROR_CODE_TOTP_ALREADY_ENABLED,
  ERROR_CODE_NO_PENDING_2FA,
  ERROR_CODE_NO_PENDING_2FA_SETUP,
  ERROR_CODE_NO_PENDING_DISABLE,
  ERROR_CODE_DISABLE_2FA_INIT_FAILED,
  ERROR_CODE_USER_NOT_FOUND,
  ERROR_CODE_SERVER_MISCONFIGURED,
  ERROR_CODE_INVALID_BASE64,
  ERROR_CODE_TOO_MANY_ATTEMPTS,
  ERROR_CODE_CONVERSATION_NOT_FOUND,
  ERROR_CODE_MODEL_NOT_FOUND,
  ERROR_CODE_LAST_MESSAGE_NOT_USER,
  ERROR_CODE_BALANCE_RESERVED,
  ERROR_CODE_DAILY_LIMIT_EXCEEDED,
  ERROR_CODE_PAYMENT_NOT_FOUND,
  ERROR_CODE_PAYMENT_ALREADY_PROCESSED,
  ERROR_CODE_PAYMENT_EXPIRED,
  ERROR_CODE_PAYMENT_DECLINED,
  ERROR_CODE_PAYMENT_CREATE_FAILED,
  ERROR_CODE_PAYMENT_MISSING_TRANSACTION_ID,
  ERROR_CODE_INVALID_SIGNATURE,
  ERROR_CODE_INVALID_JSON,
  ERROR_CODE_WEBHOOK_VERIFIER_MISSING,
  ERROR_CODE_PREMIUM_REQUIRES_BALANCE,
  ERROR_CODE_PREMIUM_REQUIRES_ACCOUNT,
  ERROR_CODE_TRIAL_MESSAGE_TOO_EXPENSIVE,
  ERROR_CODE_AUTHENTICATED_ON_TRIAL,
  ERROR_CODE_FEATURE_REQUIRES_AUTH,
  ERROR_CODE_MEMBER_LIMIT_REACHED,
  ERROR_CODE_PRIVILEGE_INSUFFICIENT,
  ERROR_CODE_MEMBER_NOT_FOUND,
  ERROR_CODE_CANNOT_REMOVE_OWNER,
  ERROR_CODE_ALREADY_MEMBER,
  ERROR_CODE_CANNOT_REMOVE_SELF,
  ERROR_CODE_CANNOT_CHANGE_OWN_PRIVILEGE,
  ERROR_CODE_LINK_NOT_FOUND,
  ERROR_CODE_EPOCH_NOT_FOUND,
  ERROR_CODE_MESSAGE_NOT_FOUND,
  ERROR_CODE_SHARE_NOT_FOUND,
  ERROR_CODE_WRAP_SET_MISMATCH,
  ERROR_CODE_ROTATION_REQUIRED,
  ERROR_CODE_REGENERATION_BLOCKED_BY_OTHER_USER,
  ERROR_CODE_FORK_NOT_FOUND,
  ERROR_CODE_FORK_NAME_TAKEN,
  ERROR_CODE_FORK_LIMIT_REACHED,
  ERROR_CODE_TARGET_MESSAGE_NOT_FOUND,
  ERROR_CODE_CANNOT_REGENERATE_WHILE_STREAMING,
  ERROR_CODE_CONTEXT_LENGTH_EXCEEDED,
  ERROR_CODE_STREAM_ERROR,
  ERROR_CODE_BILLING_ERROR,
  ERROR_CODE_CHAT_STREAM_FAILED,
} from './error.js';

describe('legacyErrorResponseSchema', () => {
  it('accepts error response with just code', () => {
    const input = { code: 'UNAUTHORIZED' };
    const result = legacyErrorResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.code).toBe('UNAUTHORIZED');
      expect(result.data.details).toBeUndefined();
    }
  });

  it('accepts error response with code and details', () => {
    const input = {
      code: 'VALIDATION',
      details: { field: 'email', message: 'Invalid email format' },
    };
    const result = legacyErrorResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.code).toBe('VALIDATION');
      expect(result.data.details).toEqual({ field: 'email', message: 'Invalid email format' });
    }
  });

  it('rejects response without code', () => {
    const input = { details: { field: 'email' } };
    const result = legacyErrorResponseSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects empty object', () => {
    const result = legacyErrorResponseSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('general error codes', () => {
  it('exports UNAUTHORIZED code', () => {
    expect(ERROR_CODE_UNAUTHORIZED).toBe('UNAUTHORIZED');
  });

  it('exports NOT_FOUND code', () => {
    expect(ERROR_CODE_NOT_FOUND).toBe('NOT_FOUND');
  });

  it('exports VALIDATION code', () => {
    expect(ERROR_CODE_VALIDATION).toBe('VALIDATION');
  });

  it('exports INSUFFICIENT_BALANCE code', () => {
    expect(ERROR_CODE_INSUFFICIENT_BALANCE).toBe('INSUFFICIENT_BALANCE');
  });

  it('exports RATE_LIMITED code', () => {
    expect(ERROR_CODE_RATE_LIMITED).toBe('RATE_LIMITED');
  });

  it('exports INTERNAL code', () => {
    expect(ERROR_CODE_INTERNAL).toBe('INTERNAL');
  });

  it('exports FORBIDDEN code', () => {
    expect(ERROR_CODE_FORBIDDEN).toBe('FORBIDDEN');
  });

  it('exports PAYMENT_REQUIRED code', () => {
    expect(ERROR_CODE_PAYMENT_REQUIRED).toBe('PAYMENT_REQUIRED');
  });

  it('exports CONFLICT code', () => {
    expect(ERROR_CODE_CONFLICT).toBe('CONFLICT');
  });

  it('exports INVALID_OPERATION code', () => {
    expect(ERROR_CODE_INVALID_OPERATION).toBe('INVALID_OPERATION');
  });

  it('exports EXPIRED code', () => {
    expect(ERROR_CODE_EXPIRED).toBe('EXPIRED');
  });

  it('exports SERVICE_UNAVAILABLE code', () => {
    expect(ERROR_CODE_SERVICE_UNAVAILABLE).toBe('SERVICE_UNAVAILABLE');
  });

  it('exports BILLING_MISMATCH code', () => {
    expect(ERROR_CODE_BILLING_MISMATCH).toBe('BILLING_MISMATCH');
  });

  it('exports CSRF_REJECTED code', () => {
    expect(ERROR_CODE_CSRF_REJECTED).toBe('CSRF_REJECTED');
  });

  it('exports SESSION_REVOKED code', () => {
    expect(ERROR_CODE_SESSION_REVOKED).toBe('SESSION_REVOKED');
  });

  it('exports PASSWORD_CHANGED code', () => {
    expect(ERROR_CODE_PASSWORD_CHANGED).toBe('PASSWORD_CHANGED');
  });
});

describe('auth error codes', () => {
  it('exports AUTH_FAILED code', () => {
    expect(ERROR_CODE_AUTH_FAILED).toBe('AUTH_FAILED');
  });

  it('exports LOGIN_FAILED code', () => {
    expect(ERROR_CODE_LOGIN_FAILED).toBe('LOGIN_FAILED');
  });

  it('exports LOGIN_INIT_FAILED code', () => {
    expect(ERROR_CODE_LOGIN_INIT_FAILED).toBe('LOGIN_INIT_FAILED');
  });

  it('exports REGISTRATION_FAILED code', () => {
    expect(ERROR_CODE_REGISTRATION_FAILED).toBe('REGISTRATION_FAILED');
  });

  it('exports USER_CREATION_FAILED code', () => {
    expect(ERROR_CODE_USER_CREATION_FAILED).toBe('USER_CREATION_FAILED');
  });

  it('exports ENCRYPTION_NOT_SETUP code', () => {
    expect(ERROR_CODE_ENCRYPTION_NOT_SETUP).toBe('ENCRYPTION_NOT_SETUP');
  });

  it('exports EMAIL_NOT_VERIFIED code', () => {
    expect(ERROR_CODE_EMAIL_NOT_VERIFIED).toBe('EMAIL_NOT_VERIFIED');
  });

  it('exports NOT_AUTHENTICATED code', () => {
    expect(ERROR_CODE_NOT_AUTHENTICATED).toBe('NOT_AUTHENTICATED');
  });

  it('exports NO_PENDING_LOGIN code', () => {
    expect(ERROR_CODE_NO_PENDING_LOGIN).toBe('NO_PENDING_LOGIN');
  });

  it('exports NO_PENDING_REGISTRATION code', () => {
    expect(ERROR_CODE_NO_PENDING_REGISTRATION).toBe('NO_PENDING_REGISTRATION');
  });

  it('exports NO_PENDING_CHANGE code', () => {
    expect(ERROR_CODE_NO_PENDING_CHANGE).toBe('NO_PENDING_CHANGE');
  });

  it('exports NO_PENDING_RECOVERY code', () => {
    expect(ERROR_CODE_NO_PENDING_RECOVERY).toBe('NO_PENDING_RECOVERY');
  });

  it('exports INCORRECT_PASSWORD code', () => {
    expect(ERROR_CODE_INCORRECT_PASSWORD).toBe('INCORRECT_PASSWORD');
  });

  it('exports CHANGE_PASSWORD_FAILED code', () => {
    expect(ERROR_CODE_CHANGE_PASSWORD_FAILED).toBe('CHANGE_PASSWORD_FAILED');
  });

  it('exports CHANGE_PASSWORD_INIT_FAILED code', () => {
    expect(ERROR_CODE_CHANGE_PASSWORD_INIT_FAILED).toBe('CHANGE_PASSWORD_INIT_FAILED');
  });

  it('exports CHANGE_PASSWORD_REG_FAILED code', () => {
    expect(ERROR_CODE_CHANGE_PASSWORD_REG_FAILED).toBe('CHANGE_PASSWORD_REG_FAILED');
  });

  it('exports ACCOUNT_KEY_NOT_AVAILABLE code', () => {
    expect(ERROR_CODE_ACCOUNT_KEY_NOT_AVAILABLE).toBe('ACCOUNT_KEY_NOT_AVAILABLE');
  });

  it('exports VERIFICATION_FAILED code', () => {
    expect(ERROR_CODE_VERIFICATION_FAILED).toBe('VERIFICATION_FAILED');
  });

  it('exports INVALID_OR_EXPIRED_TOKEN code', () => {
    expect(ERROR_CODE_INVALID_OR_EXPIRED_TOKEN).toBe('INVALID_OR_EXPIRED_TOKEN');
  });
});

describe('2FA error codes', () => {
  it('exports 2FA_VERIFICATION_FAILED code', () => {
    expect(ERROR_CODE_2FA_VERIFICATION_FAILED).toBe('2FA_VERIFICATION_FAILED');
  });

  it('exports 2FA_REQUIRED code', () => {
    expect(ERROR_CODE_2FA_REQUIRED).toBe('2FA_REQUIRED');
  });

  it('exports 2FA_EXPIRED code', () => {
    expect(ERROR_CODE_2FA_EXPIRED).toBe('2FA_EXPIRED');
  });

  it('exports INVALID_TOTP_CODE code', () => {
    expect(ERROR_CODE_INVALID_TOTP_CODE).toBe('INVALID_TOTP_CODE');
  });

  it('exports TOTP_NOT_CONFIGURED code', () => {
    expect(ERROR_CODE_TOTP_NOT_CONFIGURED).toBe('TOTP_NOT_CONFIGURED');
  });

  it('exports TOTP_NOT_ENABLED code', () => {
    expect(ERROR_CODE_TOTP_NOT_ENABLED).toBe('TOTP_NOT_ENABLED');
  });

  it('exports TOTP_ALREADY_ENABLED code', () => {
    expect(ERROR_CODE_TOTP_ALREADY_ENABLED).toBe('TOTP_ALREADY_ENABLED');
  });

  it('exports NO_PENDING_2FA code', () => {
    expect(ERROR_CODE_NO_PENDING_2FA).toBe('NO_PENDING_2FA');
  });

  it('exports NO_PENDING_2FA_SETUP code', () => {
    expect(ERROR_CODE_NO_PENDING_2FA_SETUP).toBe('NO_PENDING_2FA_SETUP');
  });

  it('exports NO_PENDING_DISABLE code', () => {
    expect(ERROR_CODE_NO_PENDING_DISABLE).toBe('NO_PENDING_DISABLE');
  });

  it('exports DISABLE_2FA_INIT_FAILED code', () => {
    expect(ERROR_CODE_DISABLE_2FA_INIT_FAILED).toBe('DISABLE_2FA_INIT_FAILED');
  });
});

describe('infrastructure error codes', () => {
  it('exports USER_NOT_FOUND code', () => {
    expect(ERROR_CODE_USER_NOT_FOUND).toBe('USER_NOT_FOUND');
  });

  it('exports SERVER_MISCONFIGURED code', () => {
    expect(ERROR_CODE_SERVER_MISCONFIGURED).toBe('SERVER_MISCONFIGURED');
  });

  it('exports INVALID_BASE64 code', () => {
    expect(ERROR_CODE_INVALID_BASE64).toBe('INVALID_BASE64');
  });

  it('exports TOO_MANY_ATTEMPTS code', () => {
    expect(ERROR_CODE_TOO_MANY_ATTEMPTS).toBe('TOO_MANY_ATTEMPTS');
  });
});

describe('domain error codes', () => {
  it('exports CONVERSATION_NOT_FOUND code', () => {
    expect(ERROR_CODE_CONVERSATION_NOT_FOUND).toBe('CONVERSATION_NOT_FOUND');
  });

  it('exports MODEL_NOT_FOUND code', () => {
    expect(ERROR_CODE_MODEL_NOT_FOUND).toBe('MODEL_NOT_FOUND');
  });

  it('exports LAST_MESSAGE_NOT_USER code', () => {
    expect(ERROR_CODE_LAST_MESSAGE_NOT_USER).toBe('LAST_MESSAGE_NOT_USER');
  });

  it('exports BALANCE_RESERVED code', () => {
    expect(ERROR_CODE_BALANCE_RESERVED).toBe('BALANCE_RESERVED');
  });

  it('exports DAILY_LIMIT_EXCEEDED code', () => {
    expect(ERROR_CODE_DAILY_LIMIT_EXCEEDED).toBe('DAILY_LIMIT_EXCEEDED');
  });

  it('exports PAYMENT_NOT_FOUND code', () => {
    expect(ERROR_CODE_PAYMENT_NOT_FOUND).toBe('PAYMENT_NOT_FOUND');
  });

  it('exports PAYMENT_ALREADY_PROCESSED code', () => {
    expect(ERROR_CODE_PAYMENT_ALREADY_PROCESSED).toBe('PAYMENT_ALREADY_PROCESSED');
  });

  it('exports PAYMENT_EXPIRED code', () => {
    expect(ERROR_CODE_PAYMENT_EXPIRED).toBe('PAYMENT_EXPIRED');
  });

  it('exports PAYMENT_DECLINED code', () => {
    expect(ERROR_CODE_PAYMENT_DECLINED).toBe('PAYMENT_DECLINED');
  });

  it('exports PAYMENT_CREATE_FAILED code', () => {
    expect(ERROR_CODE_PAYMENT_CREATE_FAILED).toBe('PAYMENT_CREATE_FAILED');
  });

  it('exports PAYMENT_MISSING_TRANSACTION_ID code', () => {
    expect(ERROR_CODE_PAYMENT_MISSING_TRANSACTION_ID).toBe('PAYMENT_MISSING_TRANSACTION_ID');
  });

  it('exports INVALID_SIGNATURE code', () => {
    expect(ERROR_CODE_INVALID_SIGNATURE).toBe('INVALID_SIGNATURE');
  });

  it('exports INVALID_JSON code', () => {
    expect(ERROR_CODE_INVALID_JSON).toBe('INVALID_JSON');
  });

  it('exports WEBHOOK_VERIFIER_MISSING code', () => {
    expect(ERROR_CODE_WEBHOOK_VERIFIER_MISSING).toBe('WEBHOOK_VERIFIER_MISSING');
  });

  it('exports PREMIUM_REQUIRES_BALANCE code', () => {
    expect(ERROR_CODE_PREMIUM_REQUIRES_BALANCE).toBe('PREMIUM_REQUIRES_BALANCE');
  });

  it('exports PREMIUM_REQUIRES_ACCOUNT code', () => {
    expect(ERROR_CODE_PREMIUM_REQUIRES_ACCOUNT).toBe('PREMIUM_REQUIRES_ACCOUNT');
  });

  it('exports TRIAL_MESSAGE_TOO_EXPENSIVE code', () => {
    expect(ERROR_CODE_TRIAL_MESSAGE_TOO_EXPENSIVE).toBe('TRIAL_MESSAGE_TOO_EXPENSIVE');
  });

  it('exports AUTHENTICATED_ON_TRIAL code', () => {
    expect(ERROR_CODE_AUTHENTICATED_ON_TRIAL).toBe('AUTHENTICATED_ON_TRIAL');
  });

  it('exports FEATURE_REQUIRES_AUTH code', () => {
    expect(ERROR_CODE_FEATURE_REQUIRES_AUTH).toBe('FEATURE_REQUIRES_AUTH');
  });

  it('exports MEMBER_LIMIT_REACHED code', () => {
    expect(ERROR_CODE_MEMBER_LIMIT_REACHED).toBe('MEMBER_LIMIT_REACHED');
  });

  it('exports PRIVILEGE_INSUFFICIENT code', () => {
    expect(ERROR_CODE_PRIVILEGE_INSUFFICIENT).toBe('PRIVILEGE_INSUFFICIENT');
  });

  it('exports MEMBER_NOT_FOUND code', () => {
    expect(ERROR_CODE_MEMBER_NOT_FOUND).toBe('MEMBER_NOT_FOUND');
  });

  it('exports CANNOT_REMOVE_OWNER code', () => {
    expect(ERROR_CODE_CANNOT_REMOVE_OWNER).toBe('CANNOT_REMOVE_OWNER');
  });

  it('exports ALREADY_MEMBER code', () => {
    expect(ERROR_CODE_ALREADY_MEMBER).toBe('ALREADY_MEMBER');
  });

  it('exports CANNOT_REMOVE_SELF code', () => {
    expect(ERROR_CODE_CANNOT_REMOVE_SELF).toBe('CANNOT_REMOVE_SELF');
  });

  it('exports CANNOT_CHANGE_OWN_PRIVILEGE code', () => {
    expect(ERROR_CODE_CANNOT_CHANGE_OWN_PRIVILEGE).toBe('CANNOT_CHANGE_OWN_PRIVILEGE');
  });

  it('exports LINK_NOT_FOUND code', () => {
    expect(ERROR_CODE_LINK_NOT_FOUND).toBe('LINK_NOT_FOUND');
  });

  it('exports EPOCH_NOT_FOUND code', () => {
    expect(ERROR_CODE_EPOCH_NOT_FOUND).toBe('EPOCH_NOT_FOUND');
  });

  it('exports MESSAGE_NOT_FOUND code', () => {
    expect(ERROR_CODE_MESSAGE_NOT_FOUND).toBe('MESSAGE_NOT_FOUND');
  });

  it('exports SHARE_NOT_FOUND code', () => {
    expect(ERROR_CODE_SHARE_NOT_FOUND).toBe('SHARE_NOT_FOUND');
  });

  it('exports WRAP_SET_MISMATCH code', () => {
    expect(ERROR_CODE_WRAP_SET_MISMATCH).toBe('WRAP_SET_MISMATCH');
  });

  it('exports ROTATION_REQUIRED code', () => {
    expect(ERROR_CODE_ROTATION_REQUIRED).toBe('ROTATION_REQUIRED');
  });

  it('exports REGENERATION_BLOCKED_BY_OTHER_USER code', () => {
    expect(ERROR_CODE_REGENERATION_BLOCKED_BY_OTHER_USER).toBe(
      'REGENERATION_BLOCKED_BY_OTHER_USER'
    );
  });

  it('exports FORK_NOT_FOUND code', () => {
    expect(ERROR_CODE_FORK_NOT_FOUND).toBe('FORK_NOT_FOUND');
  });

  it('exports FORK_NAME_TAKEN code', () => {
    expect(ERROR_CODE_FORK_NAME_TAKEN).toBe('FORK_NAME_TAKEN');
  });

  it('exports FORK_LIMIT_REACHED code', () => {
    expect(ERROR_CODE_FORK_LIMIT_REACHED).toBe('FORK_LIMIT_REACHED');
  });

  it('exports TARGET_MESSAGE_NOT_FOUND code', () => {
    expect(ERROR_CODE_TARGET_MESSAGE_NOT_FOUND).toBe('TARGET_MESSAGE_NOT_FOUND');
  });

  it('exports CANNOT_REGENERATE_WHILE_STREAMING code', () => {
    expect(ERROR_CODE_CANNOT_REGENERATE_WHILE_STREAMING).toBe('CANNOT_REGENERATE_WHILE_STREAMING');
  });
});

describe('SSE streaming error codes', () => {
  it('exports CONTEXT_LENGTH_EXCEEDED code', () => {
    expect(ERROR_CODE_CONTEXT_LENGTH_EXCEEDED).toBe('CONTEXT_LENGTH_EXCEEDED');
  });

  it('exports STREAM_ERROR code', () => {
    expect(ERROR_CODE_STREAM_ERROR).toBe('STREAM_ERROR');
  });

  it('exports BILLING_ERROR code', () => {
    expect(ERROR_CODE_BILLING_ERROR).toBe('BILLING_ERROR');
  });

  it('exports CHAT_STREAM_FAILED code', () => {
    expect(ERROR_CODE_CHAT_STREAM_FAILED).toBe('CHAT_STREAM_FAILED');
  });
});

describe('LegacyErrorResponse type', () => {
  it('can be used as a type annotation with code only', () => {
    const response: LegacyErrorResponse = { code: 'TEST' };
    expect(response.code).toBe('TEST');
  });

  it('can be used with code and details', () => {
    const response: LegacyErrorResponse = {
      code: 'TEST',
      details: { foo: 'bar' },
    };
    expect(response.code).toBe('TEST');
    expect(response.details).toEqual({ foo: 'bar' });
  });
});
