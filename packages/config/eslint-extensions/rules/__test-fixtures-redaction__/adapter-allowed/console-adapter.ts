// Deliberately console-using fixture standing in for the telemetry console
// adapter: the one file where raw console calls are legal (it IS the
// emission seam) — in both the bare and the globalThis chain form.
const line = JSON.stringify({ level: 'info', msg: 'booted' });

console.info(line);
console.debug(`{"level":"debug","msg":"probe"}`);
globalThis.console.info('{"level":"info","msg":"probe"}');
