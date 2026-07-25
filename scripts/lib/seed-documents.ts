/**
 * The seeded "Document showcase" conversation — one assistant message per
 * document-panel path, so a developer running `pnpm dev` can open the panel and
 * exercise every path locally without waiting on a model.
 *
 * Pure content: the seed orchestrator persists these messages verbatim through
 * the dev conversation factory.
 *
 * Streaming is deliberately not represented here. The local mock provider echoes
 * a prompt back chunk by chunk with a per-chunk delay, so pasting any document
 * below into the composer exercises the streaming path at observable speed.
 */

/** Written apart from the template literals below so no content has to escape it. */
const FENCE = '```';

/** A lead-in line, a blank line, then one fenced block — how a model answers. */
function fenced(leadIn: string, language: string, body: string): string {
  return `${leadIn}\n\n${FENCE}${language}\n${body}\n${FENCE}`;
}

const HTML_COUNTER = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Tally</title>
    <style>
      body {
        font-family: system-ui, sans-serif;
        display: grid;
        place-items: center;
        min-height: 100vh;
        margin: 0;
      }
      output {
        display: block;
        font-size: 4rem;
        text-align: center;
        font-variant-numeric: tabular-nums;
      }
      button {
        font-size: 1.1rem;
        padding: 0.5rem 1.5rem;
        border-radius: 999px;
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <main>
      <output id="tally">0</output>
      <button id="add" type="button">Add one</button>
    </main>
    <script>
      const tally = document.getElementById('tally');
      let count = 0;
      document.getElementById('add').addEventListener('click', () => {
        count += 1;
        tally.textContent = String(count);
      });
    </script>
  </body>
</html>`;

const REACT_CONFETTI = `import confetti from 'canvas-confetti';

const button = {
  fontSize: '1.1rem',
  padding: '0.5rem 1.5rem',
  borderRadius: '999px',
  cursor: 'pointer',
};

function celebrate() {
  confetti({
    particleCount: 140,
    spread: 70,
    origin: { y: 0.6 },
  });
}

export default function Celebration() {
  return (
    <main style={{ display: 'grid', placeItems: 'center', gap: '1rem', padding: '3rem' }}>
      <h1>Confetti on demand</h1>
      <p>canvas-confetti is imported by bare specifier and resolved at render time.</p>
      <button type="button" style={button} onClick={celebrate}>
        Celebrate
      </button>
    </main>
  );
}`;

const PYTHON_FIGURE = `import numpy as np
import matplotlib.pyplot as plt

# A damped oscillation, sampled over four periods.
t = np.linspace(0, 4 * np.pi, 400)
signal = np.exp(-t / 6) * np.sin(2 * t)

peak = int(np.argmax(signal))
step = float(t[1] - t[0])

print(f"samples: {signal.size}")
print(f"peak amplitude: {signal[peak]:.4f} at t = {t[peak]:.4f}")
print(f"mean amplitude: {float(signal.mean()):.4f}")
print(f"energy: {float(np.sum(signal ** 2) * step):.4f}")

fig, ax = plt.subplots()
ax.plot(t, signal, label="exp(-t/6) * sin(2t)")
ax.axvline(t[peak], linestyle="--", label="first peak")
ax.set_xlabel("t")
ax.set_ylabel("amplitude")
ax.set_title("Damped oscillation")
ax.legend()`;

const MERMAID_FLOW = `flowchart TD
  A[Model writes a fenced block] --> B{Language declared?}
  B -- no --> C[Stays a plain code block]
  B -- yes --> D{Mermaid, or 15+ lines?}
  D -- no --> C
  D -- yes --> E[Becomes a document card]
  E --> F{Which language?}
  F -- mermaid --> G[Rendered in the app]
  F -- html, js, jsx, python --> H[Sandbox iframe]
  H --> I{Runs on open?}
  I -- html, js, jsx --> J[Renders immediately]
  I -- python --> K[Waits for Run]
  K --> L[Console output and figures]
  J --> M[Rendered / Raw toggle]
  L --> M`;

const REACT_COMPILE_ERROR = `const stages = ['parse', 'transpile', 'render'];

export default function Pipeline() {
  return (
    <section>
      <h1>Compile failure</h1>
      <p>This document never reaches the renderer.</p>
      <ul>
        {stages.map((stage) => (
          <li key={stage}>{stage}</li>
        ))}
      </ul>
      <footer>
        <small>The element below is never closed, so the transpiler rejects the file.</small>
      <div>
    </section>
  );
}`;

const REACT_RUNTIME_ERROR = `const config = {
  title: 'Runtime failure',
  theme: { name: 'dawn' },
};

function ThemeBadge() {
  // \`config.palette\` was never defined, so reading \`.accent\` throws on mount.
  return <span style={{ color: config.palette.accent }}>{config.theme.name}</span>;
}

export default function Themed() {
  return (
    <section>
      <h1>{config.title}</h1>
      <p>This document compiles cleanly and throws while mounting.</p>
      <ThemeBadge />
    </section>
  );
}`;

/**
 * Fenced without a language on purpose: it is long enough to clear the
 * document line threshold, and stays a plain code block anyway because the
 * parser requires a declared language first.
 */
const UNTAGGED_LOG = `2026-07-24T09:14:02Z  dispatcher  claim   shard=default batch=8
2026-07-24T09:14:02Z  dispatcher  lease    job=newsletter.dispatch.v1 ttl=120s
2026-07-24T09:14:03Z  worker      start    job=newsletter.dispatch.v1 attempt=1
2026-07-24T09:14:03Z  worker      batch    recipients=500 issue=summer-notes
2026-07-24T09:14:05Z  worker      ok       delivered=500 suppressed=3
2026-07-24T09:14:05Z  dispatcher  complete job=newsletter.dispatch.v1 duration=2.1s
2026-07-24T09:14:05Z  dispatcher  rearm    next=+30s
2026-07-24T09:14:35Z  dispatcher  claim    shard=default batch=0
2026-07-24T09:14:35Z  dispatcher  idle     decay=60s
2026-07-24T09:15:35Z  dispatcher  claim    shard=default batch=1
2026-07-24T09:15:35Z  worker      start    job=payment.verify.v1 attempt=2
2026-07-24T09:15:36Z  worker      yield    checkpoint=awaiting-webhook
2026-07-24T09:15:36Z  dispatcher  rearm    next=+16s
2026-07-24T09:15:52Z  worker      start    job=payment.verify.v1 attempt=3
2026-07-24T09:15:53Z  worker      ok       payment=settled
2026-07-24T09:15:53Z  dispatcher  idle     decay=120s`;

/** Title of the seeded showcase conversation, as it reads in the sidebar. */
export const DOCUMENT_SHOWCASE_TITLE = 'Document showcase';

/**
 * The showcase transcript: a user prompt, then one document per assistant
 * message. Order matches the panel's paths — render, npm import, Python
 * compute, in-app diagram, the two failure cards, and a block that must stay
 * plain code.
 */
export const DOCUMENT_SHOWCASE_MESSAGES: readonly {
  content: string;
  senderType: 'user' | 'ai';
}[] = [
  {
    senderType: 'user',
    content:
      'Show me what the document panel can do — one document per reply, covering rendering, npm imports, Python, diagrams, and what happens when a document is broken.',
  },
  {
    senderType: 'ai',
    content: fenced(
      'An HTML page with an inline script — the button updates the count in place.',
      'html',
      HTML_COUNTER
    ),
  },
  {
    senderType: 'ai',
    content: fenced(
      'A React component that pulls canvas-confetti straight from npm.',
      'jsx',
      REACT_CONFETTI
    ),
  },
  {
    senderType: 'ai',
    content: fenced(
      'Python with numpy and matplotlib — press Run for the printed summary and the figure.',
      'python',
      PYTHON_FIGURE
    ),
  },
  {
    senderType: 'ai',
    content: fenced(
      'A mermaid flowchart of how a fenced block becomes a document.',
      'mermaid',
      MERMAID_FLOW
    ),
  },
  {
    senderType: 'ai',
    content: fenced(
      'A React component with a syntax error, so the compile-failure card shows.',
      'jsx',
      REACT_COMPILE_ERROR
    ),
  },
  {
    senderType: 'ai',
    content: fenced(
      'A React component that compiles and then throws on mount — the other failure path.',
      'jsx',
      REACT_RUNTIME_ERROR
    ),
  },
  {
    senderType: 'ai',
    content: fenced(
      'And a fence with no language: long enough to be a document, but it stays plain code.',
      '',
      UNTAGGED_LOG
    ),
  },
];
