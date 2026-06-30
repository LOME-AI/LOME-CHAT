// Deliberately violating fixture: every first argument below is non-literal,
// so redaction/logger-msg-literal reports once per call.
declare const logger: {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};
declare const telemetry: { emitMetric: (...args: unknown[]) => void };
declare const dynamicMsg: string;
declare const userInput: string;

logger.info(dynamicMsg);
logger.error(`user ${userInput} failed`);
telemetry.emitMetric(dynamicMsg, 1);
logger.warn('prefix: ' + dynamicMsg);
