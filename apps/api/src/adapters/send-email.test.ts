import { describe, expect, it, vi } from 'vitest';
import { createMockEmailSender } from '../slices/notifications/index.js';
import { errAsync } from '../lib/result/index.js';
import { unavailableError } from '../lib/errors/index.js';
import { sendComposedEmail } from './send-email.js';
import type { EmailContent } from '../slices/notifications/index.js';
import type { EmailSender } from '../slices/notifications/index.js';
import type { Telemetry } from '../lib/telemetry/index.js';

const CONTENT: EmailContent = { html: '<p>hi</p>', text: 'hi' };

function noopTelemetry(): Telemetry {
  const noop = (): void => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop, emitMetric: noop, captureError: noop };
}

describe('sendComposedEmail', () => {
  it('sends the composed content to the recipient with the given subject', async () => {
    const sender = createMockEmailSender();
    const result = await sendComposedEmail(
      { sender, logger: noopTelemetry() },
      { to: 'user@example.com', subject: 'Hello', content: CONTENT, logFailure: vi.fn() }
    );

    expect(result.isOk()).toBe(true);
    const sent = sender.getSentMessages()[0];
    expect(sent).toMatchObject({
      to: 'user@example.com',
      subject: 'Hello',
      html: '<p>hi</p>',
      text: 'hi',
    });
  });

  it('logs the failure error code and returns it on the error channel', async () => {
    const failingSender: EmailSender = { send: () => errAsync(unavailableError('sender down')) };
    const logFailure = vi.fn();

    const result = await sendComposedEmail(
      { sender: failingSender, logger: noopTelemetry() },
      { to: 'user@example.com', subject: 'Hello', content: CONTENT, logFailure }
    );

    expect(logFailure).toHaveBeenCalledWith(expect.anything(), 'unavailable');
    expect(result.isErr() && result.error.code).toBe('unavailable');
  });
});
