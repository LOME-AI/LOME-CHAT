import { describe, it, expect } from 'vitest';
import {
  legacyFriendlyErrorMessage,
  customUserMessage,
  formatLockoutMessage,
} from './error-messages.js';
import * as errorCodes from './schemas/api/error.js';

describe('legacyFriendlyErrorMessage', () => {
  it('maps UNAUTHORIZED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('UNAUTHORIZED')).toBe(
      'You are not logged in. Please log in and try again.'
    );
  });

  it('maps NOT_FOUND to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('NOT_FOUND')).toBe(
      "The item you're looking for doesn't exist."
    );
  });

  it('maps VALIDATION to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('VALIDATION')).toBe(
      'Invalid input. Please check your data and try again.'
    );
  });

  it('maps INSUFFICIENT_BALANCE to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('INSUFFICIENT_BALANCE')).toBe('Insufficient balance.');
  });

  it('maps RATE_LIMITED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('RATE_LIMITED')).toBe(
      'Too many requests. Please wait a moment and try again.'
    );
  });

  it('maps INTERNAL to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('INTERNAL')).toBe(
      'Something went wrong. Please try again later.'
    );
  });

  it('maps FORBIDDEN to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('FORBIDDEN')).toBe("You don't have permission to do this.");
  });

  it('maps PAYMENT_REQUIRED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('PAYMENT_REQUIRED')).toBe(
      'Payment is required for this action.'
    );
  });

  it('maps CONFLICT to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('CONFLICT')).toBe(
      'This action conflicts with the current state. Please refresh and try again.'
    );
  });

  it('maps INVALID_OPERATION to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('INVALID_OPERATION')).toBe(
      'This operation is not supported in the current context.'
    );
  });

  it('maps EXPIRED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('EXPIRED')).toBe('This item has expired.');
  });

  it('maps SERVICE_UNAVAILABLE to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('SERVICE_UNAVAILABLE')).toBe(
      'This service is temporarily unavailable. Please try again later.'
    );
  });

  it('maps BILLING_MISMATCH to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('BILLING_MISMATCH')).toBe(
      'Billing state has changed. Please retry.'
    );
  });

  it('maps CSRF_REJECTED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('CSRF_REJECTED')).toBe(
      'Request rejected for security reasons. Please refresh and try again.'
    );
  });

  it('maps SESSION_REVOKED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('SESSION_REVOKED')).toBe(
      'Your session has been revoked. Please log in again.'
    );
  });

  it('maps PASSWORD_CHANGED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('PASSWORD_CHANGED')).toBe(
      'Your password was changed. Please log in again.'
    );
  });

  it('maps AUTH_FAILED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('AUTH_FAILED')).toBe('Invalid credentials.');
  });

  it('maps LOGIN_FAILED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('LOGIN_FAILED')).toBe(
      'Login failed. Please check your credentials and try again.'
    );
  });

  it('maps LOGIN_INIT_FAILED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('LOGIN_INIT_FAILED')).toBe('Login failed. Please try again.');
  });

  it('maps REGISTRATION_FAILED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('REGISTRATION_FAILED')).toBe(
      'Registration failed. Please try again.'
    );
  });

  it('maps USER_CREATION_FAILED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('USER_CREATION_FAILED')).toBe(
      'Account creation failed. Please try again.'
    );
  });

  it('maps ENCRYPTION_NOT_SETUP to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('ENCRYPTION_NOT_SETUP')).toBe(
      'Your account encryption is not configured. Please contact support.'
    );
  });

  it('maps EMAIL_NOT_VERIFIED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('EMAIL_NOT_VERIFIED')).toBe(
      'Please verify your email address. Check your inbox for the verification link.'
    );
  });

  it('maps NOT_AUTHENTICATED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('NOT_AUTHENTICATED')).toBe(
      'Your session has expired. Please log in again.'
    );
  });

  it('maps NO_PENDING_LOGIN to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('NO_PENDING_LOGIN')).toBe(
      'Your login session expired. Please try again.'
    );
  });

  it('maps NO_PENDING_REGISTRATION to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('NO_PENDING_REGISTRATION')).toBe(
      'Your registration session expired. Please start over.'
    );
  });

  it('maps NO_PENDING_CHANGE to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('NO_PENDING_CHANGE')).toBe(
      'Your password change session expired. Please start over.'
    );
  });

  it('maps NO_PENDING_RECOVERY to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('NO_PENDING_RECOVERY')).toBe(
      'Your recovery session expired. Please start over.'
    );
  });

  it('maps INCORRECT_PASSWORD to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('INCORRECT_PASSWORD')).toBe('Incorrect password.');
  });

  it('maps CHANGE_PASSWORD_FAILED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('CHANGE_PASSWORD_FAILED')).toBe(
      'Password change failed. Please try again.'
    );
  });

  it('maps CHANGE_PASSWORD_INIT_FAILED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('CHANGE_PASSWORD_INIT_FAILED')).toBe(
      'Password change failed. Please try again.'
    );
  });

  it('maps CHANGE_PASSWORD_REG_FAILED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('CHANGE_PASSWORD_REG_FAILED')).toBe(
      'Password change failed. Please try again.'
    );
  });

  it('maps ACCOUNT_KEY_NOT_AVAILABLE to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('ACCOUNT_KEY_NOT_AVAILABLE')).toBe(
      'Your encryption key is unavailable. Please log out and log back in.'
    );
  });

  it('maps VERIFICATION_FAILED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('VERIFICATION_FAILED')).toBe(
      'Email verification failed. Please try again or request a new link.'
    );
  });

  it('maps INVALID_OR_EXPIRED_TOKEN to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('INVALID_OR_EXPIRED_TOKEN')).toBe(
      'This link has expired. Please request a new verification email.'
    );
  });

  it('maps 2FA_VERIFICATION_FAILED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('2FA_VERIFICATION_FAILED')).toBe(
      'Two-factor verification failed. Please try again.'
    );
  });

  it('maps 2FA_REQUIRED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('2FA_REQUIRED')).toBe(
      'Two-factor authentication is required.'
    );
  });

  it('maps 2FA_EXPIRED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('2FA_EXPIRED')).toBe(
      'Your two-factor session expired. Please log in again.'
    );
  });

  it('maps INVALID_TOTP_CODE to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('INVALID_TOTP_CODE')).toBe(
      'Invalid verification code. Please try again.'
    );
  });

  it('maps TOTP_NOT_CONFIGURED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('TOTP_NOT_CONFIGURED')).toBe(
      'Two-factor authentication is not configured. Please contact support.'
    );
  });

  it('maps TOTP_NOT_ENABLED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('TOTP_NOT_ENABLED')).toBe(
      'Two-factor authentication is not enabled on this account.'
    );
  });

  it('maps TOTP_ALREADY_ENABLED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('TOTP_ALREADY_ENABLED')).toBe(
      'Two-factor authentication is already enabled.'
    );
  });

  it('maps NO_PENDING_2FA to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('NO_PENDING_2FA')).toBe(
      'Your two-factor session expired. Please log in again.'
    );
  });

  it('maps NO_PENDING_2FA_SETUP to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('NO_PENDING_2FA_SETUP')).toBe(
      'Your two-factor setup session expired. Please start over.'
    );
  });

  it('maps NO_PENDING_DISABLE to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('NO_PENDING_DISABLE')).toBe(
      'Your two-factor disable session expired. Please start over.'
    );
  });

  it('maps DISABLE_2FA_INIT_FAILED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('DISABLE_2FA_INIT_FAILED')).toBe(
      'Failed to start two-factor disable. Please try again.'
    );
  });

  it('maps USER_NOT_FOUND to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('USER_NOT_FOUND')).toBe('Account not found.');
  });

  it('maps SERVER_MISCONFIGURED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('SERVER_MISCONFIGURED')).toBe(
      'Something went wrong on our end. Please try again later.'
    );
  });

  it('maps INVALID_BASE64 to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('INVALID_BASE64')).toBe(
      'Something went wrong with your request. Please try again.'
    );
  });

  it('maps TOO_MANY_ATTEMPTS to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('TOO_MANY_ATTEMPTS')).toBe(
      'Too many attempts. Your account has been temporarily locked.'
    );
  });

  it('maps CONVERSATION_NOT_FOUND to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('CONVERSATION_NOT_FOUND')).toBe('Conversation not found.');
  });

  it('maps MODEL_NOT_FOUND to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('MODEL_NOT_FOUND')).toBe('Model not found.');
  });

  it('maps LAST_MESSAGE_NOT_USER to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('LAST_MESSAGE_NOT_USER')).toBe(
      'Last message must be from you.'
    );
  });

  it('maps BALANCE_RESERVED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('BALANCE_RESERVED')).toBe(
      'Please wait for your current messages to finish before starting more.'
    );
  });

  it('maps DAILY_LIMIT_EXCEEDED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('DAILY_LIMIT_EXCEEDED')).toBe(
      'Daily message limit exceeded.'
    );
  });

  it('maps PAYMENT_NOT_FOUND to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('PAYMENT_NOT_FOUND')).toBe('Payment not found.');
  });

  it('maps PAYMENT_ALREADY_PROCESSED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('PAYMENT_ALREADY_PROCESSED')).toBe(
      'Payment already processed.'
    );
  });

  it('maps PAYMENT_EXPIRED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('PAYMENT_EXPIRED')).toBe('Payment expired.');
  });

  it('maps PAYMENT_DECLINED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('PAYMENT_DECLINED')).toBe('Payment declined.');
  });

  it('maps PAYMENT_CREATE_FAILED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('PAYMENT_CREATE_FAILED')).toBe('Failed to create payment.');
  });

  it('maps PAYMENT_MISSING_TRANSACTION_ID to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('PAYMENT_MISSING_TRANSACTION_ID')).toBe(
      'Payment approved but missing transaction ID.'
    );
  });

  it('maps INVALID_SIGNATURE to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('INVALID_SIGNATURE')).toBe(
      'Something went wrong with your request. Please try again.'
    );
  });

  it('maps INVALID_JSON to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('INVALID_JSON')).toBe(
      'Something went wrong with your request. Please try again.'
    );
  });

  it('maps WEBHOOK_VERIFIER_MISSING to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('WEBHOOK_VERIFIER_MISSING')).toBe(
      'Webhook processing unavailable.'
    );
  });

  it('maps PREMIUM_REQUIRES_BALANCE to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('PREMIUM_REQUIRES_BALANCE')).toBe(
      'Premium models require a positive balance.'
    );
  });

  it('maps PREMIUM_REQUIRES_ACCOUNT to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('PREMIUM_REQUIRES_ACCOUNT')).toBe(
      'Premium models require a free account.'
    );
  });

  it('maps MODEL_TIER_LOCKED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('MODEL_TIER_LOCKED')).toBe(
      'This model is only available for paid accounts. Top up your balance to unlock.'
    );
  });

  it('maps TRIAL_MESSAGE_TOO_EXPENSIVE to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('TRIAL_MESSAGE_TOO_EXPENSIVE')).toBe(
      'This message exceeds trial limits. Sign up for more capacity.'
    );
  });

  it('maps AUTHENTICATED_ON_TRIAL to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('AUTHENTICATED_ON_TRIAL')).toBe(
      'Authenticated users should use the main chat.'
    );
  });

  it('maps FEATURE_REQUIRES_AUTH to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('FEATURE_REQUIRES_AUTH')).toBe(
      'This feature requires a free account. Please sign up to use it.'
    );
  });

  it('maps MEMBER_LIMIT_REACHED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('MEMBER_LIMIT_REACHED')).toBe(
      'Conversation has reached the maximum of 100 members.'
    );
  });

  it('maps PRIVILEGE_INSUFFICIENT to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('PRIVILEGE_INSUFFICIENT')).toBe(
      'Insufficient privilege for this action.'
    );
  });

  it('maps MEMBER_NOT_FOUND to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('MEMBER_NOT_FOUND')).toBe('Member not found.');
  });

  it('maps CANNOT_REMOVE_OWNER to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('CANNOT_REMOVE_OWNER')).toBe(
      'Cannot remove the conversation owner.'
    );
  });

  it('maps ALREADY_MEMBER to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('ALREADY_MEMBER')).toBe('User is already an active member.');
  });

  it('maps CANNOT_REMOVE_SELF to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('CANNOT_REMOVE_SELF')).toBe(
      'Use the leave button to leave a conversation.'
    );
  });

  it('maps CANNOT_CHANGE_OWN_PRIVILEGE to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('CANNOT_CHANGE_OWN_PRIVILEGE')).toBe(
      'Cannot change your own privilege.'
    );
  });

  it('maps LINK_NOT_FOUND to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('LINK_NOT_FOUND')).toBe('Link not found or already revoked.');
  });

  it('maps EPOCH_NOT_FOUND to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('EPOCH_NOT_FOUND')).toBe(
      'This conversation is out of sync. Please refresh the page.'
    );
  });

  it('maps MESSAGE_NOT_FOUND to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('MESSAGE_NOT_FOUND')).toBe('Message not found.');
  });

  it('maps SHARE_NOT_FOUND to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('SHARE_NOT_FOUND')).toBe('Shared message not found.');
  });

  it('maps SHARE_FORBIDDEN to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('SHARE_FORBIDDEN')).toBe("You can't share this message.");
  });

  it('maps WRAP_SET_MISMATCH to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('WRAP_SET_MISMATCH')).toBe(
      'Members changed while you were working. Please try again.'
    );
  });

  it('maps ROTATION_REQUIRED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('ROTATION_REQUIRED')).toBe(
      "This action couldn't complete because the conversation changed. Please try again."
    );
  });

  it('maps STALE_EPOCH to user-facing message naming the actual cause', () => {
    expect(legacyFriendlyErrorMessage('STALE_EPOCH')).toBe(
      'Someone else just changed this conversation. Please try again.'
    );
  });

  it('maps REGENERATION_BLOCKED_BY_OTHER_USER to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('REGENERATION_BLOCKED_BY_OTHER_USER')).toBe(
      'Cannot regenerate — another user has replied after this message.'
    );
  });

  it('maps FORK_NOT_FOUND to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('FORK_NOT_FOUND')).toBe('Fork not found.');
  });

  it('maps FORK_NAME_TAKEN to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('FORK_NAME_TAKEN')).toBe(
      'A fork with this name already exists.'
    );
  });

  it('maps FORK_LIMIT_REACHED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('FORK_LIMIT_REACHED')).toBe(
      'Maximum number of forks reached for this conversation.'
    );
  });

  it('maps FORK_ID_REQUIRED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('FORK_ID_REQUIRED')).toBe(
      'Something went wrong. Please refresh the page and try again.'
    );
  });

  it('maps TARGET_MESSAGE_NOT_FOUND to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('TARGET_MESSAGE_NOT_FOUND')).toBe(
      'Target message not found.'
    );
  });

  it('maps INVALID_PARENT_MESSAGE to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('INVALID_PARENT_MESSAGE')).toBe(
      'Something went wrong saving your message. Please try again.'
    );
  });

  it('maps CANNOT_REGENERATE_WHILE_STREAMING to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('CANNOT_REGENERATE_WHILE_STREAMING')).toBe(
      'Please wait for the current response to finish.'
    );
  });

  it('maps UPGRADE_REQUIRED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('UPGRADE_REQUIRED')).toBe(
      'A new version is available. Please update to continue.'
    );
  });

  it('maps LOGIN_TOKEN_INVALID to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('LOGIN_TOKEN_INVALID')).toBe(
      'This login link has expired or already been used.'
    );
  });

  it('maps BILLING_SESSION_RESTRICTED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('BILLING_SESSION_RESTRICTED')).toBe(
      'This session can only access billing. Please log in normally for full access.'
    );
  });

  it('maps BUILD_NOT_FOUND to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('BUILD_NOT_FOUND')).toBe(
      'The requested app version was not found.'
    );
  });

  it('maps CHAT_STREAM_FAILED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('CHAT_STREAM_FAILED')).toBe(
      'Something went wrong. Please try again or try a different model.'
    );
  });

  it('maps STREAM_ERROR to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('STREAM_ERROR')).toBe(
      'Something went wrong. Please try again or try a different model.'
    );
  });

  it('maps BILLING_ERROR to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('BILLING_ERROR')).toBe(
      'Something went wrong saving your message. Your balance was not charged.'
    );
  });

  it('maps CONTEXT_LENGTH_EXCEEDED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('CONTEXT_LENGTH_EXCEEDED')).toBe(
      'This conversation is too long for the selected model. Try a model with a larger context window.'
    );
  });

  it('maps CONTENT_POLICY to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('CONTENT_POLICY')).toBe(
      'The model declined to answer because it considered the request unsafe. Try rephrasing your message.'
    );
  });

  it('maps PROVIDER_BILLING to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('PROVIDER_BILLING')).toBe(
      "The AI provider rejected our credentials. We're investigating; please try again shortly."
    );
  });

  it('maps NETWORK_ERROR to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('NETWORK_ERROR')).toBe(
      "We couldn't reach the AI provider. Check your connection and try again."
    );
  });

  it('maps STORAGE_WRITE_FAILED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('STORAGE_WRITE_FAILED')).toBe(
      "We couldn't save the generated media. Please try again."
    );
  });

  it('maps STORAGE_READ_FAILED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('STORAGE_READ_FAILED')).toBe(
      "We couldn't load this media. Please refresh the page."
    );
  });

  it('maps CONTENT_ITEM_NOT_FOUND to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('CONTENT_ITEM_NOT_FOUND')).toBe('Content item not found.');
  });

  it('maps CONTENT_ITEM_NOT_MEDIA to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('CONTENT_ITEM_NOT_MEDIA')).toBe(
      'This content item is not downloadable media.'
    );
  });

  it('maps INFERENCE_FAILED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('INFERENCE_FAILED')).toBe(
      "The AI provider couldn't complete your request. Please try again in a moment."
    );
  });

  it('maps EMPTY_MEDIA_RESULT to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('EMPTY_MEDIA_RESULT')).toBe(
      "The AI didn't produce any output for your request. Try rephrasing your prompt."
    );
  });

  it('maps UNKNOWN_MIME_TYPE to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('UNKNOWN_MIME_TYPE')).toBe(
      "The generated media couldn't be identified. Please report this."
    );
  });

  it('maps MEDIA_TRIAL_BLOCKED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('MEDIA_TRIAL_BLOCKED')).toBe(
      'Media generation is only available for signed-in users. Create an account to unlock.'
    );
  });

  it('maps MODALITY_MISMATCH to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('MODALITY_MISMATCH')).toBe(
      "One or more selected models don't match the requested content type."
    );
  });

  it('maps MISSING_MODALITY_CONFIG to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('MISSING_MODALITY_CONFIG')).toBe(
      'The selected content type needs configuration (aspect ratio, duration, or resolution).'
    );
  });

  it('maps UNSUPPORTED_RESOLUTION to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('UNSUPPORTED_RESOLUTION')).toBe(
      "One or more selected video models don't support the requested resolution. Pick a different resolution."
    );
  });

  it('maps AUDIO_DISABLED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('AUDIO_DISABLED')).toBe(
      'Audio generation is not yet available. Please try a different content type.'
    );
  });

  it('maps CLASSIFIER_FAILED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('CLASSIFIER_FAILED')).toBe(
      'Smart Model could not pick the best model for your message. Please try again.'
    );
  });

  it('maps DELETE_ACCOUNT_LOCKED to a duration-agnostic fallback', () => {
    expect(legacyFriendlyErrorMessage('DELETE_ACCOUNT_LOCKED')).toBe(
      'Too many deletion attempts. Try again later.'
    );
  });

  it('maps TOTP_CODE_REQUIRED to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('TOTP_CODE_REQUIRED')).toBe(
      'Enter your 6-digit verification code to continue.'
    );
  });

  it('maps INVALID_CONFIRMATION_PHRASE to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('INVALID_CONFIRMATION_PHRASE')).toBe(
      "Confirmation text didn't match."
    );
  });

  it('maps NO_PENDING_DELETE_ACCOUNT to user-facing message', () => {
    expect(legacyFriendlyErrorMessage('NO_PENDING_DELETE_ACCOUNT')).toBe(
      'Your deletion session expired. Start again.'
    );
  });

  it('returns generic fallback for unknown codes', () => {
    expect(legacyFriendlyErrorMessage('TOTALLY_UNKNOWN_CODE')).toBe(
      'Something went wrong. Please try again.'
    );
  });

  it('returns generic fallback for empty string', () => {
    expect(legacyFriendlyErrorMessage('')).toBe('Something went wrong. Please try again.');
  });
});

describe('formatLockoutMessage', () => {
  it('formats sub-minute lockouts as seconds', () => {
    expect(formatLockoutMessage(1)).toBe('Too many attempts. Try again in 1 second.');
    expect(formatLockoutMessage(45)).toBe('Too many attempts. Try again in 45 seconds.');
    expect(formatLockoutMessage(59)).toBe('Too many attempts. Try again in 59 seconds.');
  });

  it('formats sub-hour lockouts as minutes, rounding up', () => {
    expect(formatLockoutMessage(60)).toBe('Too many attempts. Try again in 1 minute.');
    expect(formatLockoutMessage(61)).toBe('Too many attempts. Try again in 2 minutes.');
    expect(formatLockoutMessage(120)).toBe('Too many attempts. Try again in 2 minutes.');
    expect(formatLockoutMessage(3599)).toBe('Too many attempts. Try again in 60 minutes.');
  });

  it('formats >=1h lockouts as hours, rounding up', () => {
    expect(formatLockoutMessage(3600)).toBe('Too many attempts. Try again in 1 hour.');
    expect(formatLockoutMessage(3601)).toBe('Too many attempts. Try again in 2 hours.');
    expect(formatLockoutMessage(7200)).toBe('Too many attempts. Try again in 2 hours.');
    expect(formatLockoutMessage(24 * 60 * 60)).toBe('Too many attempts. Try again in 24 hours.');
  });

  it('falls back for non-positive inputs', () => {
    expect(formatLockoutMessage(0)).toBe('Too many attempts. Try again in a moment.');
    expect(formatLockoutMessage(-5)).toBe('Too many attempts. Try again in a moment.');
  });

  it('falls back for non-finite inputs', () => {
    expect(formatLockoutMessage(Number.NaN)).toBe('Too many attempts. Try again in a moment.');
    expect(formatLockoutMessage(Number.POSITIVE_INFINITY)).toBe(
      'Too many attempts. Try again in a moment.'
    );
  });
});

describe('customUserMessage', () => {
  it('returns the input string unchanged', () => {
    const result = customUserMessage('Custom error message for the user.');
    expect(result).toBe('Custom error message for the user.');
  });

  it('preserves markdown in custom messages', () => {
    const result = customUserMessage('Please [sign up](/signup) to continue.');
    expect(result).toBe('Please [sign up](/signup) to continue.');
  });
});

describe('error code completeness', () => {
  /**
   * Iterates every `ERROR_CODE_*` constant exported from the error schema and
   * asserts that {@link legacyFriendlyErrorMessage} returns a real, non-fallback
   * message for it. This is the guardrail that keeps "add a new code" honest:
   * if you forget the entry in `ERROR_MESSAGES`, this test fails for the new
   * code. The fallback string is the one returned for unknown inputs.
   */
  const FALLBACK_MESSAGE = 'Something went wrong. Please try again.';

  function collectAllErrorCodes(): string[] {
    return Object.entries(errorCodes)
      .filter(([key, value]) => key.startsWith('ERROR_CODE_') && typeof value === 'string')
      .map(([, value]) => value as string);
  }

  it('exports at least one ERROR_CODE_* constant', () => {
    expect(collectAllErrorCodes().length).toBeGreaterThan(0);
  });

  it('has a non-fallback friendly message for every exported error code', () => {
    const allCodes = collectAllErrorCodes();
    const missing = allCodes.filter(
      (code) => legacyFriendlyErrorMessage(code) === (FALLBACK_MESSAGE as unknown as string)
    );
    expect(missing).toEqual([]);
  });
});
