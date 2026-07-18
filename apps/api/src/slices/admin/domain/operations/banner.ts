import { ADMIN_OP_CONTRACTS, bannerConfigSchema } from '@hushbox/shared';
import { validationError } from '../../../../lib/errors/index.js';
import { err, ok } from '../../../../lib/result/index.js';
import { defineAdminOp } from '../registry.js';
import type { z } from 'zod';
import type { BannerMessage } from '@hushbox/shared';
import type { BannerConfigStore } from '../../../announcements/index.js';

/**
 * The self-inverse `banner.set` over the announcements slice's published
 * within-tx config surface. Setting the banner is undone by setting the PRIOR
 * config back, so the op is its own registered inverse: the body snapshots the
 * prior row (locked `FOR UPDATE`, which also serializes concurrent executes)
 * into `inverseInput` before writing — inverse snapshot semantics.
 */

const setContract = ADMIN_OP_CONTRACTS['banner.set'];

/** The three config-store methods the op composes; never a db handle. */
export interface AdminBannerDeps {
  readonly bannerConfig: Pick<
    BannerConfigStore,
    'readActive' | 'readForUpdateWithinTx' | 'setWithinTx'
  >;
}

const messageInputSchema = setContract.input.shape.messages.element;

type BannerMessageInput = z.output<typeof messageInputSchema>;

/**
 * Narrows one SALVAGED prior message to the strict admin contract: text,
 * variant, and linkText (salvage already trims and caps it, so a salvaged
 * linkText always passes the strict rules) are restored; the href survives
 * only when it passes the contract's rules (absolute http(s), ≤2048). A
 * legacy relative href — which the public salvage path admits but the admin
 * contract rejects — is NOT resurrected by undo, and the salvage-only `id`
 * is not representable in the contract, so it drops.
 */
function toContractMessage(message: BannerMessage): BannerMessageInput {
  const base = {
    variant: message.variant,
    text: message.text,
    ...(message.linkText === undefined ? {} : { linkText: message.linkText }),
  };
  const withHref = messageInputSchema.safeParse({ ...base, href: message.href });
  if (withHref.success) return withHref.data;
  // Salvaged text/variant/linkText always satisfy the strict schema; a throw
  // here is a defect (500 + rollback), never an operational state.
  return messageInputSchema.parse(base);
}

export const bannerSet = defineAdminOp<AdminBannerDeps, (typeof setContract)['input']>(
  setContract,
  {
    /**
     * Current-state form prefill over the plain (non-locking) newest-row
     * read — deliberately NOT `getActiveBanner`, which empties a disabled
     * config: the operator editing the banner must see the raw draft state.
     * The same salvage→strict narrowing as the inverse snapshot keeps every
     * seeded value form-valid; `reason` is never included.
     */
    prefill: (deps) =>
      deps.bannerConfig.readActive().map((row) => {
        const salvaged = bannerConfigSchema.parse(row ?? { enabled: false, messages: [] });
        return {
          enabled: salvaged.enabled,
          messages: salvaged.messages.map((message) => toContractMessage(message)),
        };
      }),
    execute: async (ctx, input) => {
      // Cross-field rule deliberately deferred out of the contract (the input
      // must stay a plain ZodObject): an enabled banner needs something to show.
      if (input.enabled && input.messages.length === 0) {
        return err(validationError('an enabled banner requires at least one message'));
      }
      const prior = await ctx.deps.bannerConfig.readForUpdateWithinTx(ctx.tx);
      // The prior row is operator-editable jsonb — untrusted. Salvage it the
      // way the public read does, then narrow to the strict contract.
      const salvaged = bannerConfigSchema.parse(prior);
      const priorMessages = salvaged.messages.map((message) => toContractMessage(message));
      // An enabled prior row whose messages all salvaged away renders as no
      // banner; its inverse spells that same effective state as disabled,
      // because the strict contract (this op body) refuses enabled-with-zero.
      const inverseInput = setContract.input.parse({
        enabled: salvaged.enabled && priorMessages.length > 0,
        messages: priorMessages,
        reason: 'undo of banner.set',
      });
      // Conditional spreads strip the absent-optional keys (`href?`,
      // `linkText?`) whose `| undefined` the contract's output type carries
      // but `BannerMessage`'s exact-optional properties refuse.
      const nextMessages: BannerMessage[] = input.messages.map((message) => ({
        variant: message.variant,
        text: message.text,
        ...(message.href === undefined ? {} : { href: message.href }),
        ...(message.linkText === undefined ? {} : { linkText: message.linkText }),
      }));
      await ctx.deps.bannerConfig.setWithinTx(ctx.tx, {
        enabled: input.enabled,
        messages: nextMessages,
      });
      return ok({
        effects: [
          {
            label: 'banner.config',
            before: { enabled: salvaged.enabled, messages: salvaged.messages },
            after: { enabled: input.enabled, messages: input.messages },
          },
        ],
        inverseInput,
      });
    },
  }
);
