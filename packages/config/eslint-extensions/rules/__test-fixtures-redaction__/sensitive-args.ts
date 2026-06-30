// Deliberately violating fixture: each logger call below passes exactly one
// expression whose name matches the /message|prompt|content|body|text/i
// heuristic, so redaction/no-sensitive-log-argument reports once per call.
// Together the statements cover every AST shape the argument walker sees
// through: identifiers, member properties (dot and string-index), object keys,
// spreads, arrays, template/call/new/await/unary/conditional wrappers, optional
// chains, and the TS expression wrappers (as / ! / satisfies).
declare const logger: {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};
declare const log: { error: (...args: unknown[]) => void };
declare const telemetry: { emitMetric: (...args: unknown[]) => void };
declare const app: { telemetry: { record: (...args: unknown[]) => void } };
declare const message: string;
declare const payload: { size: number };
declare const promptText: string;
declare const err: { responseText: string };
declare const messageAuthor: string;
declare const requestBody: { size: number };
declare const messageParts: string[];
declare const messagePromise: Promise<string>;
declare const hasContent: boolean;
declare const verbose: boolean;
declare const maybe: { bodyText?: string } | undefined;
declare const rawPrompt: unknown;
declare const maybeBody: string | undefined;
declare const contentLength: number;

logger.info('persisted', message);
logger.warn('rejected', { body: payload });
logger.debug('captured', `${promptText}`);
log.error('failed', err.responseText);
telemetry.emitMetric('chat.cost', 1, { userId: messageAuthor });
logger.error('spread', { ...requestBody });
app.telemetry.record('chat.cost', messageAuthor);
log.error('failed', err['responseText']);
logger.warn('rejected', { 'bodyBytes': 1 });
logger.info('batch', [, message]);
logger.debug('captured', JSON.stringify(requestBody));
logger.error('wrapped', new Error(message));
logger.info('parts', ...messageParts);
logger.info('awaited', await messagePromise);
logger.warn('negated', !hasContent);
logger.info('conditional', verbose ? message : 'fallback');
logger.info('chained', maybe?.bodyText);
logger.info('cast', rawPrompt as string);
logger.info('asserted', maybeBody!);
logger.info('satisfied', contentLength satisfies number);
logger.info('shorthand', { message }); // key and value are one node — exactly one finding

// `#name in obj` puts a PrivateIdentifier on a binary expression's left; the
// walker must skip it (it is a declaration reference, not a logged value) and
// still flag the right-hand operand.
class Auditor {
  #contentFlag = true;
  scan(): void {
    logger.warn('private-in', #contentFlag in requestBody);
  }
}
