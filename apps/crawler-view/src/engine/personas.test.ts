import { describe, it, expect } from 'vitest';
import { PERSONAS, getPersona, matchRobotsToken, GOOGLE_EXTENDED_TOKEN } from './personas';

describe('PERSONAS registry', () => {
  it('contains every verified persona keyed by unique id', () => {
    const ids = PERSONAS.map((persona) => persona.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('gptbot');
    expect(ids).toContain('slackbot');
    expect(ids).toContain('bytespider');
  });

  it('sends the full user agent but matches robots on the stable token', () => {
    const gptbot = getPersona('gptbot');
    expect(gptbot.userAgent).toContain('GPTBot/1.4');
    expect(gptbot.robotsToken).toBe('GPTBot');
    expect(gptbot.category).toBe('ai');
    expect(gptbot.executesJs).toBe(false);
    expect(gptbot.primarySignals).toEqual(['text', 'jsonld']);
  });

  it('marks Googlebot and Bingbot as JS-executing search crawlers', () => {
    expect(getPersona('googlebot').executesJs).toBe(true);
    expect(getPersona('bingbot').executesJs).toBe(true);
    expect(getPersona('googlebot').category).toBe('search');
  });

  it('uses the link-expanding token for Slackbot', () => {
    expect(getPersona('slackbot').robotsToken).toBe('Slackbot-LinkExpanding');
  });

  it('exposes Google-Extended as a robots-only opt-out token, not a persona', () => {
    expect(GOOGLE_EXTENDED_TOKEN).toBe('Google-Extended');
    expect(PERSONAS.some((persona) => persona.id === 'google-extended')).toBe(false);
  });
});

describe('getPersona', () => {
  it('throws for an unknown id', () => {
    expect(() => getPersona('nope')).toThrow(/unknown persona/i);
  });
});

describe('matchRobotsToken', () => {
  it('matches case-insensitively when the group targets the persona token', () => {
    expect(matchRobotsToken('gptbot', 'GPTBot')).toBe(true);
    expect(matchRobotsToken('GPTBOT', 'GPTBot')).toBe(true);
  });

  it('does not match an unrelated group', () => {
    expect(matchRobotsToken('bingbot', 'GPTBot')).toBe(false);
  });

  it('matches when the robots group is a prefix of the token', () => {
    expect(matchRobotsToken('Slackbot', 'Slackbot-LinkExpanding')).toBe(true);
  });

  it('matches a group that is a shorter prefix of the token', () => {
    expect(matchRobotsToken('Google', 'Googlebot')).toBe(true);
  });

  it('does not match a group that is only an interior substring of the token', () => {
    expect(matchRobotsToken('bot', 'bingbot')).toBe(false);
    expect(matchRobotsToken('SearchBot', 'OAI-SearchBot')).toBe(false);
  });
});
