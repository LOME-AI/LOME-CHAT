# LOME-CHAT Frontend Navigation Map

Complete navigation structure, page layouts, and URL hierarchy for LOME-CHAT.

---

## Key Design Decisions

| Decision       | Choice              | Rationale                                                  |
| -------------- | ------------------- | ---------------------------------------------------------- |
| Domain model   | Single domain       | lome-chat.com serves both marketing and app (like ChatGPT) |
| Guest access   | Limited trial       | 5 queries before signup required (like Grok)               |
| Auth methods   | Email/password only | Simpler initial implementation, OAuth added later          |
| Sidebar        | Collapsible         | Toggle to hide/show (like ChatGPT/DeepSeek)                |
| Settings       | Modal only          | No dedicated URL (like all competitors)                    |
| Document panel | Resizable split     | Draggable divider between chat and panel                   |

---

## Architecture: Two Apps, One Domain

LOME-CHAT uses two separate frontend applications deployed to the same domain:

```
lome-chat.com
├── apps/marketing/ (Astro - SSG/SSR for SEO)
│   └── Serves: /, /features, /pricing, /about, /privacy, /terms
│
└── apps/web/ (React + Vite - SPA)
    └── Serves: /chat/*, /projects/*, /login, /signup, /verify, /share/*, /pub/*
```

**Why two apps?**

- **Marketing (Astro)**: Static/SSR pages for SEO. Search engines see full content. Fast initial load.
- **App (Vite)**: SPA for interactive chat. Real-time updates, streaming, complex state.

**Deployment (Cloudflare Pages):**

- Both apps deploy together
- Cloudflare routes based on path prefix
- Marketing pages are pre-rendered at build time
- App pages are client-side rendered

---

## Page Structure and URLs

### Marketing Site (apps/marketing/ - Astro)

| Page             | URL         | Purpose                                             |
| ---------------- | ----------- | --------------------------------------------------- |
| Landing          | `/`         | Homepage - hero, value prop, features overview, CTA |
| Features         | `/features` | Detailed feature breakdown with demos               |
| Pricing          | `/pricing`  | Pricing tiers, comparison table, FAQ                |
| About            | `/about`    | Company story, team, mission                        |
| Privacy Policy   | `/privacy`  | Privacy policy (legal)                              |
| Terms of Service | `/terms`    | Terms of service (legal)                            |

### Application (apps/web/ - Vite + React)

| Page                | URL                     | Auth    | Description                         |
| ------------------- | ----------------------- | ------- | ----------------------------------- |
| Login               | `/login`                | No      | Email/password login form           |
| Signup              | `/signup`               | No      | Account creation form               |
| Email Verification  | `/verify`               | No      | Email verification handling         |
| Chat (new)          | `/chat`                 | Trial\* | New conversation (\*5 free queries) |
| Chat (existing)     | `/chat/:conversationId` | Yes     | Specific conversation               |
| Projects            | `/projects`             | Yes     | Project list and management         |
| Project Detail      | `/projects/:projectId`  | Yes     | Single project view                 |
| Shared Conversation | `/share/:shareId`       | No      | Public shared chat (read-only)      |
| Published Document  | `/pub/:documentId`      | No      | Public published document           |

\*Guest users get 5 free queries via `/chat`, then prompted to sign up.

---

## Navigation Flow Diagrams

```
CROSS-APP NAVIGATION
====================

  [Astro - Marketing]                      [Vite - App]
  ─────────────────────                    ─────────────────
         │                                        │
    /  (Landing)  ──── "Try Free" ───────►  /chat (Trial)
    /features                                     │
    /pricing     ──── "Get Started" ────►  /signup
    /about                                        ▼
         │                                  /chat/:id
         │                                  /projects
         └──────── Hard navigation ─────►   /login
                   (full page load)


NEW USER JOURNEY
================

  / (Astro)              /chat (Vite)         /signup (Vite)       /chat (Vite)
  Landing                Trial Mode           Create Account       Full Access
 ┌───────────┐          ┌────────────┐       ┌───────────────┐    ┌────────────┐
 │           │  "Try    │            │  5    │               │    │            │
 │  Product  │  Free    │  Chat UI   │  msgs │  □ Email      │    │  Full Chat │
 │  info     │ ───────► │  (Guest)   │ ────► │  □ Password   │ ──►│  History   │
 │  Pricing  │          │            │ limit │  □ Confirm    │    │  Projects  │
 │  [CTA]    │          │  No history│       │               │    │            │
 └───────────┘          └────────────┘       └───────────────┘    └────────────┘
  [Astro]                [Vite SPA]           [Vite SPA]           [Vite SPA]
                              │
                              │ Click "Sign up" (soft nav within SPA)
                              ▼
                        /signup (same flow)


RETURNING USER JOURNEY
======================

  / (Astro)              /login (Vite)        /chat (Vite)
 ┌───────────┐          ┌───────────────┐    ┌────────────────┐
 │           │  Log in  │               │    │                │
 │  Landing  │ ───────► │  □ Email      │ ──►│  Chat restored │
 │           │          │  □ Password   │    │  History shown │
 └───────────┘          └───────────────┘    └────────────────┘
  [Astro]                [Vite SPA]           [Vite SPA]
       │
       │ Direct URL /chat with valid session
       ▼
  Redirect to /chat directly (no login needed)


NAVIGATION BEHAVIOR
===================

  Astro → Vite:  Hard navigation (full page load, app bootstrap)
  Vite → Astro:  Hard navigation (full page load)
  Vite → Vite:   Soft navigation (SPA client-side routing)
```

---

## Layout Architecture

### Marketing Site (apps/marketing/ - Astro)

```
ASTRO LAYOUTS
=============

BaseLayout.astro (all pages)
├── <html> with theme class
├── <head> (SEO meta, Open Graph, scripts)
└── <body>
    ├── MarketingHeader (logo, nav links, Login/Signup CTAs)
    │   └── Links: Features, Pricing, About, | Login, Try Free
    ├── <slot /> (page content)
    └── MarketingFooter
        └── Links: Privacy, Terms, Contact, Social

Pages:
  /              → pages/index.astro
  /features      → pages/features.astro
  /pricing       → pages/pricing.astro
  /about         → pages/about.astro
  /privacy       → pages/privacy.astro
  /terms         → pages/terms.astro
```

### Application (apps/web/ - Vite + React)

```
REACT ROUTE LAYOUT HIERARCHY
============================

__root.tsx (all routes)
├── QueryProvider (TanStack Query)
├── ThemeProvider (light/dark)
├── Toaster (sonner notifications)
└── <Outlet />
    │
    ├── AUTH ROUTES (_auth.tsx) - Minimal layout for auth pages
    │   ├── Centered card layout
    │   ├── Logo header
    │   └── <Outlet />
    │       ├── /login    → login.tsx
    │       ├── /signup   → signup.tsx
    │       └── /verify   → verify.tsx
    │
    ├── APP ROUTES (_app.tsx) - Full app shell
    │   ├── AuthGuard (redirects to /login if no session)
    │   ├── GuestGuard (tracks trial usage for /chat without auth)
    │   └── AppShell
    │       ├── Sidebar (collapsible, persisted to localStorage)
    │       │   ├── Logo + collapse toggle
    │       │   ├── NewChatButton
    │       │   ├── SearchButton (opens search modal)
    │       │   ├── ChatList
    │       │   │   ├── Pinned section
    │       │   │   ├── Today section
    │       │   │   ├── Yesterday section
    │       │   │   ├── Previous 7 days
    │       │   │   └── Older (grouped by month)
    │       │   ├── ProjectsLink → /projects
    │       │   └── UserMenu (avatar dropdown)
    │       │       ├── Profile → opens ProfileModal
    │       │       ├── Settings → opens SettingsModal
    │       │       ├── Theme toggle
    │       │       ├── Keyboard shortcuts → opens ShortcutsModal
    │       │       └── Logout
    │       │
    │       └── MainArea
    │           └── <Outlet />
    │               ├── /chat           → chat.index.tsx (new conversation)
    │               ├── /chat/:id       → chat.$conversationId.tsx
    │               ├── /projects       → projects.index.tsx
    │               └── /projects/:id   → projects.$projectId.tsx
    │
    └── PUBLIC ROUTES (no layout group) - Public shared content
        ├── /share/:shareId    → share.$shareId.tsx (read-only chat view)
        └── /pub/:documentId   → pub.$documentId.tsx (published document)
```

---

## Chat Interface Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  [≡]  LOME                        [Model ▼]  [🌐 Search]  [⚙️]  [Avatar ▼]   │
├─────────────────┬────────────────────────────────┬───────────────────────────┤
│  LEFT SIDEBAR   │      MAIN CHAT AREA            │    DOCUMENT PANEL         │
│  (Collapsible)  │                                │    (Resizable)            │
│                 │                                │                           │
│  [+ New Chat]   │  ┌────────────────────────┐    │  [Code] [Preview] [Diff]  │
│                 │  │                        │    │  ┌─────────────────────┐  │
│  ─ PINNED ─     │  │   Conversation         │    │  │                     │  │
│  • Project A    │  │   Thread               │    │  │  Document/Code      │  │
│                 │  │                        │    │  │  Content            │  │
│  ─ TODAY ─      │  │   User: [message]      │    │  │                     │  │
│  • Chat 1       │  │   AI: [response]       │    │  │  [Edit] [Copy]      │  │
│  • Chat 2       │  │   [👍][👎][📋][↻]     │    │  │                     │  │
│                 │  │                        │    │  └─────────────────────┘  │
│  ─ YESTERDAY ─  │  └────────────────────────┘    │                           │
│  • Chat 3       │                                │  Version: 3 of 5          │
│                 │  ┌────────────────────────┐    │  [◄ Prev] [Next ►]        │
│  ─ THIS WEEK ─  │  │ [📎][🖼️] Message...    │    │                           │
│  • ...          │  │ [Extended Thinking ▼]  │    │  [Download] [Publish]     │
│                 │  │              [Send ➤]  │    │                           │
│  ─────────────  │  └────────────────────────┘    │                           │
│  [🔍 Search]    │                                │                           │
│  [Projects →]   │  [Context: 12k/128k tokens]    │                           │
│                 │                                │                           │
│  ─────────────  │                                │                           │
│  [👤 Profile]   │                                │◄─── Drag handle ───►      │
└─────────────────┴────────────────────────────────┴───────────────────────────┘
```

---

## Modal/Panel Definitions

| Modal               | Trigger Location            | Content                                     |
| ------------------- | --------------------------- | ------------------------------------------- |
| Settings            | User menu → Settings        | General, Data controls, Privacy, Billing    |
| Profile             | User menu → Profile         | Name, avatar, email, password change        |
| Model Info          | Model selector → (i) icon   | Model capabilities, pricing, context limits |
| Keyboard Shortcuts  | `?` key or Help menu        | Shortcut reference                          |
| Share Conversation  | Message menu → Share        | Generate share link, permissions            |
| New Project         | Projects → + New            | Project name, description                   |
| Delete Confirmation | Delete buttons              | Confirm destructive action                  |
| Trial Limit         | After 5 guest messages      | Signup prompt with value prop               |
| Quick Analytics     | Chat header → Analytics     | Token usage, cost, context %                |
| Search              | Sidebar → Search or `Cmd+K` | Full-text search across conversations       |

---

## Route Guard Logic

```typescript
// MARKETING SITE (Astro) - All public, no guards needed
/              - Landing page (Astro)
/features      - Features page (Astro)
/pricing       - Pricing page (Astro)
/about         - About page (Astro)
/privacy       - Privacy policy (Astro)
/terms         - Terms of service (Astro)

// APPLICATION (Vite + React) - Guards in TanStack Router beforeLoad

// Auth routes - redirect to /chat if already logged in
/login         - Login form (redirect if session exists)
/signup        - Signup form (redirect if session exists)
/verify        - Email verification (token validation)

// Public app routes - no auth required
/share/:id     - Public shared chat (read-only, no auth)
/pub/:id       - Published documents (read-only, no auth)

// Trial route - guest access with limits
/chat          - New conversation (allow guest, cheap models, limited context, track usage)
               - After 5 messages → show TrialLimitModal → redirect to /signup

// Protected routes - require auth, redirect to /login if not
/chat/:id      - Specific conversation (must own or have share access)
/projects      - All projects (must be authenticated)
/projects/:id  - Specific project (must own or be team member)
```

---

## State Requirements

| Page          | Server State (TanStack Query)   | Client State (Zustand)                                                                         |
| ------------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| /chat         | conversations, messages, models | sidebarOpen, selectedModelId, pendingMessages, streamingContent, guestMessageCount             |
| /chat/:id     | conversation, messages          | sidebarOpen, selectedModelId, pendingMessages, streamingContent, documentPanelOpen, panelWidth |
| /projects     | projects                        | sidebarOpen                                                                                    |
| /projects/:id | project, conversations, files   | sidebarOpen                                                                                    |

---

## Mobile Considerations

| Breakpoint          | Sidebar                         | Document Panel          | Behavior        |
| ------------------- | ------------------------------- | ----------------------- | --------------- |
| Desktop (≥1024px)   | Collapsible, visible by default | Resizable side panel    | Full experience |
| Tablet (768-1023px) | Overlay drawer                  | Bottom sheet or overlay | Tap to toggle   |
| Mobile (<768px)     | Full-screen drawer              | Full-screen takeover    | Swipe gestures  |

---

## Guest Trial Implementation

- Store `guestMessageCount` in localStorage key `lome-guest-trial`
- Increment count on each message sent without authentication
- At 5 messages, display `TrialLimitModal` with signup CTA
- Clear count on successful signup/login
- Abuse limiting logic to prevent circumvention
