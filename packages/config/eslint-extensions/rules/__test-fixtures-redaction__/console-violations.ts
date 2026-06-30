// Deliberately violating fixture: every console call here must be reported
// by redaction/no-raw-console (all-literal calls as 'banned', anything with a
// non-literal argument as 'interpolation'). The globalThis.console chain is
// the same sink and must not evade the ban.
const requestId = 'r-1';

console.log('plain literal');
console.info(`request ${requestId} arrived`);
console.warn(requestId);
console.error('failed', requestId);
console.debug(`expressionless template`);
globalThis.console.log('plain literal');
globalThis.console.error('failed', requestId);
