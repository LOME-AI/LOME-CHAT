import { newsletterIssueEmail } from '../../notifications/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { EmailSender } from '../../notifications/index.js';

/** The two public origins an issue email links against. */
export interface IssueEmailUrls {
  /** The API's own public origin (`API_URL`) — the one-click POST target. */
  readonly apiUrl: string;
  /** The web app origin (`FRONTEND_URL`) — the human goodbye page. */
  readonly frontendUrl: string;
}

export interface RenderIssueEmailParams {
  readonly subject: string;
  readonly bodyMarkdown: string;
  readonly unsubscribeToken: string;
  readonly urls: IssueEmailUrls;
}

export interface RenderedIssueEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly headers: Record<string, string>;
}

function unsubscribeUrl(origin: string, token: string): string {
  const url = new URL('/newsletter/unsubscribe', origin);
  url.searchParams.set('token', token);
  return url.toString();
}

/**
 * One recipient's issue email: the notifications template over the shared
 * markdown body, personalized only by the unsubscribe token. The visible link
 * targets the frontend goodbye page (a browser GET); the RFC 8058 one-click
 * headers target the API endpoint directly — mail clients POST
 * `List-Unsubscribe=One-Click` there, which the unsubscribe route accepts via
 * its query-string token.
 */
export function renderIssueEmail(params: RenderIssueEmailParams): RenderedIssueEmail {
  const content = newsletterIssueEmail({
    subject: params.subject,
    bodyMarkdown: params.bodyMarkdown,
    unsubscribeUrl: unsubscribeUrl(params.urls.frontendUrl, params.unsubscribeToken),
  });
  return {
    subject: params.subject,
    html: content.html,
    text: content.text,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl(params.urls.apiUrl, params.unsubscribeToken)}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

export interface SendIssueTestParams {
  readonly sender: EmailSender;
  readonly subject: string;
  readonly bodyMarkdown: string;
  readonly to: string;
}

/**
 * The admin test-send: the same template a real dispatch renders, but with an
 * inert unsubscribe link (visible, going nowhere) and no one-click headers —
 * a preview to a chosen address, never a delivery record. No issue row, no
 * delivery rows.
 */
export function sendIssueTest(params: SendIssueTestParams): ResultAsync<void, DomainError> {
  const content = newsletterIssueEmail({
    subject: params.subject,
    bodyMarkdown: params.bodyMarkdown,
    unsubscribeUrl: '#',
  });
  return params.sender.send({
    to: params.to,
    subject: params.subject,
    html: content.html,
    text: content.text,
  });
}
