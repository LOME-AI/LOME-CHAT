---
name: HushBox
description: Warm, quiet-but-expressive, editorial, privacy-first.
colors:
  brand-red: "#ec4755"
  brand-red-hover: "#d93d4a"
  white: "#ffffff"
  background: "#faf9f6"
  background-paper: "#faf5ed"
  background-subtle: "#eae8e3"
  foreground: "#1a1a1a"
  foreground-muted: "#525252"
  border: "#b5b1a8"
  border-strong: "#8f8b81"
  secondary: "#e5e2db"
  error: "#dc2626"
  warning: "#d97706"
  info: "#2563eb"
  success: "#16a34a"
  violet: "#8b5cf6"
  sidebar: "#f5f4f0"
  sidebar-border: "#d1cfc9"
  message-user: "#d4cdc4"
  background-dark: "#1a1816"
  background-paper-dark: "#252320"
  background-subtle-dark: "#2d2b28"
  foreground-dark: "#f2f1ef"
  foreground-muted-dark: "#9a9894"
  border-dark: "#3d3a36"
  border-strong-dark: "#4a4743"
  accent-dark: "#2d2b28"
  error-dark: "#ef4444"
  warning-dark: "#f59e0b"
  info-dark: "#3b82f6"
  success-dark: "#22c55e"
  sidebar-dark: "#141311"
  message-user-dark: "#2a2725"
  red-light: "#f87171"
  blue-light: "#60a5fa"
  green-light: "#4ade80"
  amber-light: "#fbbf24"
  violet-light: "#a78bfa"
typography:
  display:
    fontFamily: "Merriweather, Georgia, serif"
    fontSize: "clamp(1.75rem, 4vw, 3rem)"
    fontWeight: 700
    lineHeight: 1.15
  body:
    fontFamily: "Merriweather, Georgia, serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.6
  ui:
    fontFamily: "Hanken Grotesk, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 500
    lineHeight: 1.4
  mono:
    fontFamily: "JetBrains Mono, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.brand-red}"
    textColor: "{colors.white}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
  card:
    backgroundColor: "{colors.background-paper}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "1rem"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "0.5rem 0.75rem"
---

# Design System: HushBox

## 1. Overview

**Creative North Star: "The Private Study"**

A quiet, warm room for thinking in private: paper-and-ink calm, an editorial voice, one decisive mark of color, and nothing that announces itself. HushBox fronts a hundred AI models but reads like none of them. The surface is warm rather than clinical, the type is set like a publication rather than a dashboard, and motion is present but unhurried. It is expressive by default and trustworthy by construction: every choice is deliberate and recorded, so the familiar warmth of paper and serif is a committed identity, not a reflex.

What this system rejects: the generic AI-chat look (gray bubbles, sparkle empty states, purple gradients), surveillance-SaaS coldness, hype-y neon marketing, and any dark pattern. Common is not the enemy; reflex is.

**Key Characteristics:**
- Warm paper surfaces, never pure white; warm charcoal in dark, never pure black.
- One saturated brand red, used as a signal, never as decoration.
- An editorial serif for reading, a humanist sans for chrome, mono for code.
- Expressive by default; calm is one accessibility toggle away.

## 2. Colors

A warm-neutral system carrying a single decisive accent. Every color comes from a token; literal hex in product code is drift.

### Primary
- **Signal Red** (#ec4755): the one brand accent. Primary actions, current selection, focus rings, headings, links. Hover deepens to **Signal Red Deep** (#d93d4a). Used sparingly; its rarity is the point.

### Neutral (warm paper to ink)
- **Warm Paper** (#faf9f6): the body background. Lower-glare than white, calm to read against for hours.
- **Paper Cream** (#faf5ed): raised surfaces, cards, popovers.
- **Paper Subtle** (#eae8e3): muted panels and wells.
- **Ink** (#1a1a1a) and **Muted Ink** (#525252): primary and secondary text.
- **Warm Border** (#b5b1a8) and **Strong Border** (#8f8b81): hairlines and dividers.
- Dark mode is a warm charcoal scale (background #1a1816, paper #252320), not inverted light, with depth from surface lightness rather than shadow.

### Semantic
- **Error** (#dc2626), **Warning** (#d97706), **Info** (#2563eb), **Success** (#16a34a). The error red is deliberately distinct from the brand red so danger never reads as branding. (Dark-mode variants: #ef4444 / #f59e0b / #3b82f6 / #22c55e.)

### Named Rules
**The One Red Rule.** The brand red appears on a small fraction of any screen and only as a signal (action, selection, focus, heading). It is never a background wash or decoration. The error red is reserved for danger and is never used for emphasis.

**The Warm-Surface Rule.** No pure-white (#ffffff) or pure-black (#000000) canvas. Surfaces are warm paper in light and warm charcoal in dark. This is committed identity, not a default to flee from.

## 3. Typography

**Reading Font:** Merriweather (with Georgia, serif fallback)
**UI Font:** Hanken Grotesk (with system-ui, sans-serif fallback)
**Code Font:** JetBrains Mono (with monospace fallback)

**Character:** An editorial serif gives reading surfaces a considered, trustworthy, publication-like voice; a warm humanist sans keeps dense product chrome crisp at small sizes; mono carries code and data. Personality comes from scale, weight, and rhythm, not from reaching for a trendy face.

### Hierarchy
- **Display** (Merriweather, 700, clamp to ~3rem, line-height 1.15): hero and section headlines.
- **Body** (Merriweather, 400, ~1.0625rem, line-height 1.6): reading content, chat messages, long-form prose. Measure 65 to 75ch.
- **UI** (Hanken Grotesk, 500, ~0.9375rem, line-height 1.4): buttons, labels, form fields, settings rows, navigation, data.
- **Code** (JetBrains Mono, 400, ~0.875rem): code blocks, keystrokes, metadata, tabular numbers.

### Named Rules
**The Reading-versus-Chrome Rule.** Reading surfaces use the serif; product UI chrome uses the sans; code uses mono. Do not set dense UI chrome in the serif, and do not set reading prose in the sans.

## 4. Elevation

Flat by default. Depth comes from warm surface layering (paper over background over subtle) and hairline borders, not from heavy shadow. Where a shadow is used, it is low and warm-tinted, never a hard black drop. In dark mode, elevation is conveyed by lighter warm-charcoal surfaces rather than shadow.

### Named Rules
**The Flat-by-Default Rule.** Surfaces are flat at rest. A shadow appears only as a response to state (hover, active elevation, focus), and it is soft and warm, never decorative.

## 5. Components

### Buttons
- **Shape:** medium radius (6px). Pills (9999px) only for tags and small chips.
- **Primary:** Signal Red fill, white text; hover deepens to Signal Red Deep; tactile press (slight translate or scale-down on active).
- **Secondary / ghost:** warm neutral surface or transparent with a hairline; never a second saturated color.
- Every interactive element ships default, hover, focus-visible, active, disabled, loading states.

### Inputs / Fields
- Warm paper background, hairline border, medium radius. Label above the field, error below. Focus ring in Signal Red. Placeholders meet the same 4.5:1 contrast as body text.

### Cards / Containers
- Paper-cream background, large radius (8px), hairline border, generous internal padding. Flat at rest. Never nested.

### Navigation
- Calm, consistent. Sidebar and top chrome use the UI sans, tagged as structural chrome. Active state marked with Signal Red, not just position.

### Message surfaces
- The user message carries a subtle warm fill; the assistant message is transparent so the content carries itself. The words are the design.

### Signature
- The CipherWall encrypted-state indicator and the circular theme-reveal wipe are HushBox's concentrated boldness. One memorable animated moment; everything around it stays quiet.

## 6. Do's and Don'ts

### Do
- **Do** derive every color and type decision from these tokens; use `var(--token)`, never a literal hex in product code.
- **Do** keep the brand red to a small fraction of any screen, as a signal only.
- **Do** set reading surfaces in the serif and product chrome in the sans.
- **Do** make every surface survive the accessibility widget: contrast, inversion, scaling, loosened spacing, and stopped motion.
- **Do** gate every animation through the motion-aware helper so it degrades to a no-op.

### Don't
- **Don't** use a pure-white or pure-black canvas; the warm paper and warm charcoal are committed.
- **Don't** use the error red for emphasis, or any second saturated accent.
- **Don't** ship the generic AI-chat look: gray symmetrical bubbles, a sparkle empty state with "How can I help you today?", a purple-blue gradient, an assistant-avatar blob.
- **Don't** use surveillance-SaaS coldness, hype-y neon marketing, fake urgency, or any dark pattern.
- **Don't** use long dashes (the em-dash, or the en-dash used as a separator) in user-facing copy: anything users read in the product or marketing (UI labels, buttons, error messages, prose). Use a hyphen, comma, colon, period, or parentheses. This does not govern internal text (code comments, these docs, commit messages) or a user's own chat content. This is the one canonical statement of the rule.
- **Don't** nest cards, use side-stripe borders, gradient text, the hero-metric template, identical card grids, or a tracked eyebrow above every section.

## 7. Admin app

The admin SPA (`apps/admin`) inherits this identity — tokens, dark mode, `@hushbox/ui` primitives, the accessibility conventions — with these deltas. It is an ops tool for 1–3 operators, not a product surface:

- **Density over whitespace:** tables over cards, monospace ids with copy buttons, counts over charts. Compact spacing is correct here, not a violation.
- **Function over expression:** no signature moments, no marketing polish, no empty-state illustration. The CipherWall and theme-reveal wipe do not appear.
- **The OpModal is the only mutation surface** — its form → preview-diff → execute/undo grammar is the app's one interaction signature; no bespoke confirm dialogs.
- **Keyboard-first:** the command palette is the primary navigation; every screen reachable without a pointer.

A future design pass must not "improve" the admin app toward the product's warmth; its craft bar is legibility and speed.
