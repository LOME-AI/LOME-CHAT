import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { ledgerEntries } from '../schema/ledger-entries';

type LedgerEntry = typeof ledgerEntries.$inferSelect;

const ENTRY_TYPE_FK_MAP: Record<string, 'paymentId' | 'usageRecordId' | 'sourceWalletId'> = {
  deposit: 'paymentId',
  usage_charge: 'usageRecordId',
  refund: 'paymentId',
  adjustment: 'sourceWalletId',
  renewal: 'sourceWalletId',
  welcome_credit: 'sourceWalletId',
};

export const ledgerEntryFactory = Factory.define<LedgerEntry>(({ params }) => {
  const entryType =
    params.entryType ??
    faker.helpers.arrayElement([
      'deposit',
      'usage_charge',
      'refund',
      'adjustment',
      'renewal',
      'welcome_credit',
    ]);

  const fkField = ENTRY_TYPE_FK_MAP[entryType] ?? 'sourceWalletId';
  const fkId = crypto.randomUUID();

  return {
    id: crypto.randomUUID(),
    walletId: crypto.randomUUID(),
    amount: faker.number.float({ min: -100, max: 500, fractionDigits: 8 }).toFixed(8),
    balanceAfter: faker.number.float({ min: 0, max: 1000, fractionDigits: 8 }).toFixed(8),
    entryType,
    paymentId: fkField === 'paymentId' ? fkId : null,
    usageRecordId: fkField === 'usageRecordId' ? fkId : null,
    sourceWalletId: fkField === 'sourceWalletId' ? fkId : null,
    createdAt: faker.date.recent(),
  };
});
