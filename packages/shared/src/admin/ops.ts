import { z } from 'zod';

import { NanoUSD } from '../nano-usd.js';
import { defineAdminOpContract } from './contract.js';

/**
 * Cap on a single admin wallet credit/clawback: $1,000 in nano-USD.
 * Guardrail data — bounds the blast radius of a compromised-but-valid admin
 * session; larger corrections run as multiple audited ops.
 */
export const ADMIN_WALLET_ADJUSTMENT_CAP_NANO_USD = 1_000_000_000_000n;

/**
 * Single source for the `user_lock_reason` value set — packages/db derives
 * its pgEnum from this const (the shared-const-feeds-pgEnum pattern).
 * `user.lock`'s input carries the reason so `user.unlock`'s undo can restore
 * the original value (inverse snapshot semantics), never a default.
 */
export const USER_LOCK_REASONS = ['chargeback', 'admin'] as const;

const reason = z.string().trim().min(1);

/** Positive money amount at the JSON boundary: NanoUSD wire string → bigint. */
const positiveNanoUsd = NanoUSD.refine((value) => value > 0n, {
  message: 'amount must be positive',
});

const walletAdjustmentInput = z.object({
  walletId: z.uuid(),
  amountNanoUsd: positiveNanoUsd,
  reason,
});

const userTargetInput = z.object({ userId: z.uuid(), reason });
const jobTargetInput = z.object({ jobId: z.uuid(), reason });
const modelTargetInput = z.object({ modelId: z.string().min(1), reason });
const shareTargetInput = z.object({ linkId: z.uuid(), reason });

const WALLET_GUARDRAILS = { maxAmountNanoUsd: ADMIN_WALLET_ADJUSTMENT_CAP_NANO_USD } as const;

/**
 * The v1 admin op inventory; contract facts are normative in the admin
 * slice's CLAUDE.md. Contracts only — implementations live in the admin
 * slice; the SPA and CLI render forms and commands from these same objects.
 */
export const ADMIN_OP_CONTRACTS = {
  'wallet.credit': defineAdminOpContract({
    name: 'wallet.credit',
    title: 'Credit wallet',
    kind: 'mutation',
    input: walletAdjustmentInput,
    inverse: 'wallet.clawback',
    effectClass: 'durable',
    guardrails: WALLET_GUARDRAILS,
  }),
  'wallet.clawback': defineAdminOpContract({
    name: 'wallet.clawback',
    title: 'Claw back wallet credit',
    kind: 'mutation',
    input: walletAdjustmentInput,
    inverse: 'wallet.credit',
    effectClass: 'durable',
    guardrails: WALLET_GUARDRAILS,
  }),
  'user.lock': defineAdminOpContract({
    name: 'user.lock',
    title: 'Lock account',
    kind: 'mutation',
    input: z.object({ userId: z.uuid(), lockReason: z.enum(USER_LOCK_REASONS), reason }),
    inverse: 'user.unlock',
    effectClass: 'durable',
  }),
  'user.unlock': defineAdminOpContract({
    name: 'user.unlock',
    title: 'Unlock account',
    kind: 'mutation',
    input: userTargetInput,
    inverse: 'user.lock',
    effectClass: 'durable',
  }),
  // Ephemeral: deletes session state the user recreates by logging in again.
  'sessions.revokeAll': defineAdminOpContract({
    name: 'sessions.revokeAll',
    title: 'Revoke all sessions',
    kind: 'mutation',
    input: userTargetInput,
    inverse: null,
    effectClass: 'ephemeral',
  }),
  // Ephemeral: resumes an existing system obligation (the job's effect is
  // the system's at-least-once work, not an admin-originated state change).
  'job.redrive': defineAdminOpContract({
    name: 'job.redrive',
    title: 'Redrive dead job',
    kind: 'mutation',
    input: jobTargetInput,
    inverse: null,
    effectClass: 'ephemeral',
  }),
  'job.discard': defineAdminOpContract({
    name: 'job.discard',
    title: 'Discard dead job',
    kind: 'mutation',
    input: jobTargetInput,
    inverse: 'job.restore',
    effectClass: 'durable',
  }),
  'job.restore': defineAdminOpContract({
    name: 'job.restore',
    title: 'Restore discarded job',
    kind: 'mutation',
    input: jobTargetInput,
    inverse: 'job.discard',
    effectClass: 'durable',
  }),
  'model.disable': defineAdminOpContract({
    name: 'model.disable',
    title: 'Disable model',
    kind: 'mutation',
    input: modelTargetInput,
    inverse: 'model.enable',
    effectClass: 'durable',
  }),
  'model.enable': defineAdminOpContract({
    name: 'model.enable',
    title: 'Enable model',
    kind: 'mutation',
    input: modelTargetInput,
    inverse: 'model.disable',
    effectClass: 'durable',
  }),
  'share.revoke': defineAdminOpContract({
    name: 'share.revoke',
    title: 'Revoke shared link',
    kind: 'mutation',
    input: shareTargetInput,
    inverse: 'share.unrevoke',
    effectClass: 'durable',
  }),
  'share.unrevoke': defineAdminOpContract({
    name: 'share.unrevoke',
    title: 'Un-revoke shared link',
    kind: 'mutation',
    input: shareTargetInput,
    inverse: 'share.revoke',
    effectClass: 'durable',
  }),
} as const;

/** All registered op names — the registry-exhaustiveness iteration source. */
export const ADMIN_OP_NAMES = Object.keys(
  ADMIN_OP_CONTRACTS
) as readonly (keyof typeof ADMIN_OP_CONTRACTS)[];

export type AdminOpContractName = keyof typeof ADMIN_OP_CONTRACTS;
