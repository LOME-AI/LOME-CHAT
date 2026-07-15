import { z } from 'zod';

/**
 * The billing-portal login-link mint lives in the identity slice (it writes
 * identity's Redis handoff key); the billing slice owns only the HTTP surface
 * that exposes it, so the mint is re-published through the billing barrel for
 * the `POST /billing/login-link` route. The redemption half is already mounted
 * on identity's `POST /auth/token-login`.
 */

/** The handoff response the mobile app exchanges for a billing-only session. */
export const billingLoginLinkResponseSchema = z.object({ token: z.string() });

export { issueBillingLoginToken } from '../../identity/index.js';
