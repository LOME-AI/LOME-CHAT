import {
  applyMarkup,
  estimateTokenCount,
  nanoUsdToFullDollarString,
  STORAGE_COST_PER_CHARACTER_NANO,
} from '@hushbox/shared';
import type { Model } from '@hushbox/shared';

const MESSAGES_PER_DAY = 50;
const DAYS_PER_MONTH = 30;

const SYSTEM_PROMPT_CHARS = 500;
const USER_MESSAGE_CHARS = 200;
const AI_RESPONSE_CHARS = 400;

export interface MonthlyCostResult {
  monthlyCost: number;
  modelName: string;
  messagesPerDay: number;
  daysPerMonth: number;
}

/** Combined BASE (pre-markup) nano-USD per-token rate of a model, 0 for non-text. */
function combinedTokenRateNano(model: Model): bigint {
  return BigInt(model.pricing.inputPerToken ?? '0') + BigInt(model.pricing.outputPerToken ?? '0');
}

export function calculateMonthlyCost(models: Model[]): MonthlyCostResult {
  const paidModels = models.filter((m) => combinedTokenRateNano(m) > 0n);

  if (paidModels.length === 0) {
    return {
      monthlyCost: 0,
      modelName: '',
      messagesPerDay: MESSAGES_PER_DAY,
      daysPerMonth: DAYS_PER_MONTH,
    };
  }

  let cheapest = paidModels[0];
  for (const m of paidModels) {
    if (combinedTokenRateNano(m) < combinedTokenRateNano(cheapest)) {
      cheapest = m;
    }
  }

  const inputChars = SYSTEM_PROMPT_CHARS + USER_MESSAGE_CHARS;
  const outputChars = AI_RESPONSE_CHARS;

  const inputTokens = estimateTokenCount(inputChars.toString().padEnd(inputChars, ' '));
  const outputTokens = estimateTokenCount(outputChars.toString().padEnd(outputChars, ' '));

  // All money math stays in integer nano-USD: token cost takes the customer
  // markup, pass-through storage does not, then the per-message total scales by
  // the message count. The float dollar figure is produced only at the very end
  // for the marketing chart.
  const tokenBaseNano =
    BigInt(inputTokens) * BigInt(cheapest.pricing.inputPerToken ?? '0') +
    BigInt(outputTokens) * BigInt(cheapest.pricing.outputPerToken ?? '0');
  const storageNano = BigInt(inputChars + outputChars) * STORAGE_COST_PER_CHARACTER_NANO;
  const perMessageNano = applyMarkup(tokenBaseNano) + storageNano;
  const totalNano = perMessageNano * BigInt(MESSAGES_PER_DAY * DAYS_PER_MONTH);

  return {
    monthlyCost: Number.parseFloat(nanoUsdToFullDollarString(totalNano.toString())),
    modelName: cheapest.name,
    messagesPerDay: MESSAGES_PER_DAY,
    daysPerMonth: DAYS_PER_MONTH,
  };
}
