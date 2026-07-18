import { describe, it, expect } from 'vitest';
import { ROUTES, MARKETING_BASE_URL, FOOTER_LINKS, MARKETING_ROUTES } from './routes.js';

describe('ROUTES constants', () => {
  const routeEntries = Object.entries(ROUTES);
  const routeValues = Object.values(ROUTES);

  it('contains the expected number of route definitions', () => {
    expect(routeEntries.length).toBe(25);
  });

  it('has all values as non-empty strings', () => {
    for (const [key, value] of routeEntries) {
      expect(typeof value).toBe('string');
      expect(value.length, `ROUTES.${key} is empty`).toBeGreaterThan(0);
    }
  });

  it('has all values starting with /', () => {
    for (const [key, value] of routeEntries) {
      expect(value.startsWith('/'), `ROUTES.${key} = "${value}" does not start with /`).toBe(true);
    }
  });

  it('has no duplicate route values', () => {
    const unique = new Set(routeValues);
    expect(unique.size, `Found duplicate route values`).toBe(routeValues.length);
  });

  it('has parameter placeholders prefixed with $', () => {
    const parameterRoutes = routeEntries.filter(([_, value]) => value.includes('$'));
    expect(parameterRoutes.length).toBeGreaterThan(0);
    for (const [key, value] of parameterRoutes) {
      expect(value, `ROUTES.${key} has parameter not prefixed with $`).toMatch(/\$[a-zA-Z]+/);
    }
  });

  it('matches the expected route definitions', () => {
    expect(ROUTES).toMatchInlineSnapshot(`
      {
        "ACCESSIBILITY": "/accessibility",
        "BILLING": "/billing",
        "BLOG": "/blog",
        "CHAT": "/chat",
        "CHAT_ID": "/chat/$id",
        "CHAT_NEW": "/chat/new",
        "CHAT_TRIAL": "/chat/trial",
        "DEMO": "/demo",
        "DEV_ASSETS": "/dev/assets",
        "DEV_EMAILS": "/dev/emails",
        "DEV_PERSONAS": "/dev/personas",
        "DEV_RENDER_ASSET": "/dev/render-asset/$name",
        "LEADERBOARD": "/leaderboard",
        "LOGIN": "/login",
        "MARKETING": "/welcome",
        "NEWSLETTER": "/newsletter",
        "PRIVACY": "/privacy",
        "ROADMAP": "/roadmap",
        "SETTINGS": "/settings",
        "SHARE_CONVERSATION": "/share/c/$conversationId",
        "SHARE_MESSAGE": "/share/m/$shareId",
        "SIGNUP": "/signup",
        "TERMS": "/terms",
        "USAGE": "/usage",
        "VERIFY": "/verify",
      }
    `);
  });
  it('MARKETING route is not root to prevent Astro/Vite index.html conflict', () => {
    expect(ROUTES.MARKETING).not.toBe('/');
  });
});

describe('FOOTER_LINKS', () => {
  const routeValues = new Set(Object.values(ROUTES));

  it('contains the expected footer links', () => {
    expect(FOOTER_LINKS).toMatchInlineSnapshot(`
      [
        {
          "group": "Product",
          "href": "/welcome",
          "label": "Welcome",
        },
        {
          "group": "Product",
          "href": "/chat",
          "label": "Chat",
        },
        {
          "group": "Product",
          "href": "/blog",
          "label": "Blog",
        },
        {
          "group": "Product",
          "href": "/roadmap",
          "label": "Roadmap",
        },
        {
          "group": "Product",
          "href": "/leaderboard",
          "label": "Leaderboard",
        },
        {
          "group": "Account",
          "href": "/login",
          "label": "Log In",
        },
        {
          "group": "Account",
          "href": "/signup",
          "label": "Sign Up",
        },
        {
          "group": "Legal",
          "href": "/privacy",
          "label": "Privacy",
        },
        {
          "group": "Legal",
          "href": "/terms",
          "label": "Terms",
        },
      ]
    `);
  });

  it('has every href referencing an existing ROUTES value', () => {
    for (const link of FOOTER_LINKS) {
      expect(routeValues.has(link.href), `"${link.href}" is not a value in ROUTES`).toBe(true);
    }
  });

  it('has non-empty labels and groups', () => {
    for (const link of FOOTER_LINKS) {
      expect(link.label.length).toBeGreaterThan(0);
      expect(link.group.length).toBeGreaterThan(0);
    }
  });
});

describe('MARKETING_ROUTES', () => {
  const routeValues = new Set<string>(Object.values(ROUTES));

  it('matches the expected marketing routes', () => {
    expect(MARKETING_ROUTES).toMatchInlineSnapshot(`
      [
        "/welcome",
        "/blog",
        "/newsletter",
        "/roadmap",
        "/leaderboard",
        "/privacy",
        "/terms",
      ]
    `);
  });

  it('contains only values that exist in ROUTES', () => {
    for (const route of MARKETING_ROUTES) {
      expect(routeValues.has(route), `"${route}" is not a value in ROUTES`).toBe(true);
    }
  });

  it('has no duplicate entries', () => {
    const unique = new Set(MARKETING_ROUTES);
    expect(unique.size).toBe(MARKETING_ROUTES.length);
  });

  it('has no entries pointing at the root or chat surface', () => {
    for (const route of MARKETING_ROUTES) {
      expect(route).not.toBe('/');
      expect(route.startsWith('/chat')).toBe(false);
    }
  });
});

describe('MARKETING_BASE_URL', () => {
  it('is the production hushbox.ai URL', () => {
    expect(MARKETING_BASE_URL).toBe('https://hushbox.ai');
  });

  it('has no trailing slash', () => {
    expect(MARKETING_BASE_URL.endsWith('/')).toBe(false);
  });
});
