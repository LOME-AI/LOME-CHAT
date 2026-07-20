import { redisGet, redisIncrByFloat } from './redis-registry.js';
import type { Redis } from '@upstash/redis';

export interface GroupBudgetReservation {
  conversationId: string;
  memberId: string;
  payerId: string;
  costCents: number;
}

export interface GroupReservedTotals {
  memberTotal: number;
  conversationTotal: number;
  payerTotal: number;
}

export async function getReservedTotal(redis: Redis, userId: string): Promise<number> {
  const value = await redisGet(redis, 'chatReservedBalance', userId);
  return value ?? 0;
}

export async function reserveBudget(
  redis: Redis,
  userId: string,
  costCents: number
): Promise<number> {
  return redisIncrByFloat(redis, 'chatReservedBalance', costCents, userId);
}

export async function releaseBudget(
  redis: Redis,
  userId: string,
  costCents: number
): Promise<void> {
  await redisIncrByFloat(redis, 'chatReservedBalance', -costCents, userId);
}

export async function reserveGroupBudget(
  redis: Redis,
  params: GroupBudgetReservation
): Promise<GroupReservedTotals> {
  const { conversationId, memberId, payerId, costCents } = params;

  const memberTotal = await redisIncrByFloat(
    redis,
    'groupMemberReserved',
    costCents,
    conversationId,
    memberId
  );
  const conversationTotal = await redisIncrByFloat(
    redis,
    'conversationReserved',
    costCents,
    conversationId
  );
  const payerTotal = await redisIncrByFloat(redis, 'chatReservedBalance', costCents, payerId);

  return { memberTotal, conversationTotal, payerTotal };
}

export async function releaseGroupBudget(
  redis: Redis,
  params: GroupBudgetReservation
): Promise<void> {
  const { conversationId, memberId, payerId, costCents } = params;

  await redisIncrByFloat(redis, 'groupMemberReserved', -costCents, conversationId, memberId);
  await redisIncrByFloat(redis, 'conversationReserved', -costCents, conversationId);
  await redisIncrByFloat(redis, 'chatReservedBalance', -costCents, payerId);
}

export async function getGroupReservedTotals(
  redis: Redis,
  conversationId: string,
  memberId: string,
  payerId: string
): Promise<GroupReservedTotals> {
  const [memberTotal, conversationTotal, payerTotal] = await Promise.all([
    redisGet(redis, 'groupMemberReserved', conversationId, memberId),
    redisGet(redis, 'conversationReserved', conversationId),
    redisGet(redis, 'chatReservedBalance', payerId),
  ]);

  return {
    memberTotal: memberTotal ?? 0,
    conversationTotal: conversationTotal ?? 0,
    payerTotal: payerTotal ?? 0,
  };
}
