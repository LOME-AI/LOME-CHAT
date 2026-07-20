import type { Variables } from '../types.js';

/** Narrow user to non-null. Safe after requireAuth() or requirePrivilege() middleware. */
export function getUser(c: {
  get(key: 'user'): Variables['user'];
}): NonNullable<Variables['user']> {
  const user = c.get('user');
  if (!user) throw new Error('requireAuth middleware missing');
  return user;
}
