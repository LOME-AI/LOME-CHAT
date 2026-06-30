import { z } from 'zod';

/**
 * The single closed set of conversation-member privileges, in escalation
 * order. One source feeding the pgEnum and the realtime event contracts —
 * the values are live wire/database vocabulary, so changing them is an enum
 * migration plus a client contract change, never ad-hoc data.
 */
export const MEMBER_PRIVILEGES = ['read', 'write', 'admin', 'owner'] as const;

/** Zod schema for member-privilege validation */
export const MemberPrivilege = z.enum(MEMBER_PRIVILEGES);

/** TypeScript type for member privilege */
export type MemberPrivilege = z.infer<typeof MemberPrivilege>;
