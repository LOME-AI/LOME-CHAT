import type { Persona } from './types';

/**
 * The verified persona registry (2026-07-16). The full `userAgent` is what a
 * fetch SENDS; robots.txt allow/deny is matched on the stable `robotsToken`
 * substring, never the volatile versioned full string.
 *
 * Googlebot and Bingbot execute JS in a later rendering wave, but this tool
 * validates the no-JS baseline every crawler — them included — receives on the
 * first pass; no JS rendering is performed here.
 *
 * Bytespider is widely reported to ignore robots Disallow; its verdict is still
 * computed nominally from the robots.txt it is nominally bound by.
 */
export const PERSONAS: readonly Persona[] = [
  {
    id: 'gptbot',
    label: 'GPTBot',
    vendor: 'OpenAI',
    category: 'ai',
    robotsToken: 'GPTBot',
    executesJs: false,
    primarySignals: ['text', 'jsonld'],
    userAgent:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.4; +https://openai.com/gptbot',
  },
  {
    id: 'oai-searchbot',
    label: 'OAI-SearchBot',
    vendor: 'OpenAI',
    category: 'ai',
    robotsToken: 'OAI-SearchBot',
    executesJs: false,
    primarySignals: ['text', 'jsonld'],
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36; compatible; OAI-SearchBot/1.4; +https://openai.com/searchbot',
  },
  {
    id: 'chatgpt-user',
    label: 'ChatGPT-User',
    vendor: 'OpenAI',
    category: 'ai',
    robotsToken: 'ChatGPT-User',
    executesJs: false,
    primarySignals: ['text'],
    userAgent:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  },
  {
    id: 'claudebot',
    label: 'ClaudeBot',
    vendor: 'Anthropic',
    category: 'ai',
    robotsToken: 'ClaudeBot',
    executesJs: false,
    primarySignals: ['text', 'jsonld'],
    userAgent:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  },
  {
    id: 'claude-searchbot',
    label: 'Claude-SearchBot',
    vendor: 'Anthropic',
    category: 'ai',
    robotsToken: 'Claude-SearchBot',
    executesJs: false,
    primarySignals: ['text', 'jsonld'],
    userAgent:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +https://www.anthropic.com)',
  },
  {
    id: 'claude-user',
    label: 'Claude-User',
    vendor: 'Anthropic',
    category: 'ai',
    robotsToken: 'Claude-User',
    executesJs: false,
    primarySignals: ['text'],
    userAgent:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)',
  },
  {
    id: 'perplexitybot',
    label: 'PerplexityBot',
    vendor: 'Perplexity',
    category: 'ai',
    robotsToken: 'PerplexityBot',
    executesJs: false,
    primarySignals: ['text', 'jsonld'],
    userAgent:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
  },
  {
    id: 'googlebot',
    label: 'Googlebot',
    vendor: 'Google',
    category: 'search',
    robotsToken: 'Googlebot',
    executesJs: true,
    primarySignals: ['text', 'jsonld'],
    userAgent:
      'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  },
  {
    id: 'bingbot',
    label: 'Bingbot',
    vendor: 'Microsoft',
    category: 'search',
    robotsToken: 'bingbot',
    executesJs: true,
    primarySignals: ['text', 'jsonld'],
    userAgent:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/125.0.0.0 Safari/537.36',
  },
  {
    id: 'meta-externalagent',
    label: 'meta-externalagent',
    vendor: 'Meta',
    category: 'ai',
    robotsToken: 'meta-externalagent',
    executesJs: false,
    primarySignals: ['text'],
    userAgent:
      'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
  },
  {
    id: 'facebookexternalhit',
    label: 'facebookexternalhit',
    vendor: 'Meta',
    category: 'social',
    robotsToken: 'facebookexternalhit',
    executesJs: false,
    primarySignals: ['og'],
    userAgent: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  },
  {
    id: 'twitterbot',
    label: 'Twitterbot',
    vendor: 'X',
    category: 'social',
    robotsToken: 'Twitterbot',
    executesJs: false,
    primarySignals: ['twitter', 'og'],
    userAgent: 'Twitterbot/1.0',
  },
  {
    id: 'linkedinbot',
    label: 'LinkedInBot',
    vendor: 'LinkedIn',
    category: 'social',
    robotsToken: 'LinkedInBot',
    executesJs: false,
    primarySignals: ['og'],
    userAgent:
      'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
  },
  {
    id: 'slackbot',
    label: 'Slackbot',
    vendor: 'Slack',
    category: 'social',
    robotsToken: 'Slackbot-LinkExpanding',
    executesJs: false,
    primarySignals: ['og', 'twitter'],
    userAgent: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  },
  {
    id: 'amazonbot',
    label: 'Amazonbot',
    vendor: 'Amazon',
    category: 'ai',
    robotsToken: 'Amazonbot',
    executesJs: false,
    primarySignals: ['text'],
    userAgent:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1) Chrome/125.0.0.0 Safari/537.36',
  },
  {
    id: 'bytespider',
    label: 'Bytespider',
    vendor: 'ByteDance',
    category: 'ai',
    robotsToken: 'Bytespider',
    executesJs: false,
    primarySignals: ['text'],
    userAgent: 'Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)',
  },
];

/**
 * `Google-Extended` is a robots.txt opt-out token for AI-training use with no
 * fetcher of its own. It is checked as an extra token against Googlebot's
 * AI-training opt-out, never modeled as a persona.
 */
export const GOOGLE_EXTENDED_TOKEN = 'Google-Extended';

export function getPersona(id: string): Persona {
  const persona = PERSONAS.find((candidate) => candidate.id === id);
  if (!persona) {
    throw new Error(`unknown persona: ${id}`);
  }
  return persona;
}

/**
 * A robots.txt `User-agent` group targets a persona when the group name is a
 * case-insensitive PREFIX of the persona's stable product token (RFC 9309: the
 * robots value matches the start of the crawler's product token, so `Google`
 * matches `Googlebot` but `bot` matches no persona). The `*` wildcard group is
 * handled by the robots parser, not here.
 */
export function matchRobotsToken(groupUserAgent: string, personaToken: string): boolean {
  return personaToken.toLowerCase().startsWith(groupUserAgent.toLowerCase());
}
