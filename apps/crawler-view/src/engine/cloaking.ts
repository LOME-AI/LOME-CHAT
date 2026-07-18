import { fetchRaw } from './fetch-page';
import { getPersona } from './personas';
import type { CloakingInfo } from './types';

/** A representative desktop browser UA — the baseline a human visitor presents. */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function normalizeHtml(html: string): string {
  return html.replaceAll(/\s+/g, ' ').trim();
}

/**
 * Compare what a representative bot (GPTBot) and a plain browser receive for the
 * same URL. Divergence in HTTP status, final redirect target, or normalized HTML
 * is the classic cloaking signal — content served to humans but withheld from
 * crawlers. A fetch failure leaves the check unperformed rather than asserting.
 */
export async function detectCloaking(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<CloakingInfo> {
  try {
    const botUserAgent = getPersona('gptbot').userAgent;
    const [bot, browser] = await Promise.all([
      fetchRaw(url, botUserAgent, fetchImpl),
      fetchRaw(url, BROWSER_USER_AGENT, fetchImpl),
    ]);

    if (bot.status !== browser.status) {
      return {
        checked: true,
        divergent: true,
        detail: `status ${String(browser.status)} for browsers vs ${String(bot.status)} for bots`,
      };
    }
    if (bot.finalUrl !== browser.finalUrl) {
      return {
        checked: true,
        divergent: true,
        detail: `bots are redirected to a different url (${bot.finalUrl})`,
      };
    }
    if (normalizeHtml(bot.html) !== normalizeHtml(browser.html)) {
      return { checked: true, divergent: true, detail: 'different HTML served to bots' };
    }
    return { checked: true, divergent: false, detail: null };
  } catch {
    return { checked: false, divergent: false, detail: null };
  }
}
