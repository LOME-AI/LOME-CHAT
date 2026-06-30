// Legitimate backend logging: literal messages, allowlisted field names, no raw
// console. All three redaction rules must stay silent on this file.
interface Fields {
  requestId?: string;
  latencyMs?: number;
  errorCode?: string;
}
declare const logger: {
  debug: (msg: string, fields?: Fields) => void;
  info: (msg: string, fields?: Fields) => void;
  warn: (msg: string, fields?: Fields) => void;
  error: (msg: string, fields?: Fields) => void;
};
declare const telemetry: {
  emitMetric: (name: string, value: number, dimensions?: Fields) => void;
};
declare const requestId: string;
declare function buildFields(): Fields;
declare const notALogger: { process: (input: string) => void };
declare const sample: string;

logger.info('turn settled', { requestId, latencyMs: 42 });
logger.warn(`admission refused`, buildFields());
logger.error('persist failed', { errorCode: 'conflict' });
logger.debug('probe');
telemetry.emitMetric('chat.tokens', 1280, { requestId });
notALogger.process(sample);

// Over-flag guards: receivers the rule must NOT treat as logger-shaped (a call
// result and a string-indexed member have no inspectable receiver name), plus
// non-string member indices and object keys, which carry no name to match.
declare function getLogger(): { send: (...args: unknown[]) => void };
declare const handlers: Record<string, { send: (...args: unknown[]) => void }>;
declare const rows: number[];
declare const diagnostics: { info: (...args: unknown[]) => void };

getLogger().send(sample);
handlers['log'].send(sample);
diagnostics.info('row sampled', rows[0], { 1: requestId });
