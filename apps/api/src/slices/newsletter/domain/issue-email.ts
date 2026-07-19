import { ROUTES } from '@hushbox/shared';
import { newsletterIssueEmail } from '../../notifications/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { EmailSender } from '../../notifications/index.js';

/** The API POST route the one-click `List-Unsubscribe` header targets. */
const API_UNSUBSCRIBE_PATH = '/newsletter/unsubscribe';

/** The two public origins an issue email links against. */
export interface IssueEmailUrls {
  /** The API's own public origin (`API_URL`) — the one-click POST target. */
  readonly apiUrl: string;
  /** The marketing origin (`MARKETING_URL`) — the human goodbye page. */
  readonly marketingUrl: string;
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

function unsubscribeUrl(origin: string, path: string, token: string): string {
  const url = new URL(path, origin);
  url.searchParams.set('token', token);
  return url.toString();
}

/**
 * One recipient's issue email: the notifications template over the shared
 * markdown body, personalized only by the unsubscribe token. The visible link
 * targets the marketing goodbye page (a browser GET on the marketing origin);
 * the RFC 8058 one-click header targets the API POST route directly — mail
 * clients POST `List-Unsubscribe=One-Click` there, which the unsubscribe route
 * accepts via its query-string token. The two must not converge: a human
 * clicking the page URL lands on a real page, a client POSTing the header hits
 * the API verb.
 */
export function renderIssueEmail(params: RenderIssueEmailParams): RenderedIssueEmail {
  const content = newsletterIssueEmail({
    subject: params.subject,
    bodyMarkdown: params.bodyMarkdown,
    unsubscribeUrl: unsubscribeUrl(
      params.urls.marketingUrl,
      ROUTES.NEWSLETTER_UNSUBSCRIBED,
      params.unsubscribeToken
    ),
  });
  return {
    subject: params.subject,
    html: content.html,
    text: content.text,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl(params.urls.apiUrl, API_UNSUBSCRIBE_PATH, params.unsubscribeToken)}>`,
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
