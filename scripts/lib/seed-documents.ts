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

const HTML_LIFE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Game of Life</title>
    <style>
      body {
        margin: 0;
      }
      .life {
        box-sizing: border-box;
        min-height: 100vh;
        padding: 24px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        font-family: ui-sans-serif, system-ui, sans-serif;
        color: #f2f5ff;
        background: radial-gradient(circle at 80% 0%, #123 0%, #08090f 65%);
      }
      .life h1 {
        margin: 0;
        font-size: 1.2rem;
      }
      .life p {
        margin: 0;
        font-size: 0.85rem;
        color: #93a4cc;
      }
      .life canvas {
        width: 100%;
        flex: 1;
        min-height: 220px;
        border-radius: 14px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: #05060b;
        image-rendering: pixelated;
        cursor: crosshair;
        touch-action: none;
      }
      .life .row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
      }
      .life button,
      .life select {
        font: inherit;
        color: inherit;
        cursor: pointer;
        padding: 6px 14px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        background: rgba(255, 255, 255, 0.08);
      }
      .life button:hover,
      .life select:hover {
        background: rgba(255, 255, 255, 0.16);
      }
      .life .stats {
        display: flex;
        flex-wrap: wrap;
        gap: 18px;
        font-size: 0.85rem;
        color: #93a4cc;
        font-variant-numeric: tabular-nums;
      }
      .life .stats b {
        color: #f2f5ff;
        font-weight: 600;
      }
    </style>
  </head>
  <body>
    <main class="life">
      <h1>Conway's Game of Life</h1>
      <p>Draw on the grid, pick a seed pattern, and watch the colony run. Cells warm as they age.</p>
      <canvas id="board" width="600" height="360"></canvas>
      <div class="row">
        <button id="toggle" type="button">Pause</button>
        <button id="step" type="button">Step</button>
        <button id="clear" type="button">Clear</button>
        <select id="pattern">
          <option value="gun">Gosper glider gun</option>
          <option value="pulsar">Pulsar</option>
          <option value="pentomino">R-pentomino</option>
          <option value="soup">Random soup</option>
        </select>
      </div>
      <div class="stats">
        <span>generation <b id="generation">0</b></span>
        <span>alive <b id="alive">0</b></span>
        <span>born <b id="born">0</b></span>
        <span>died <b id="died">0</b></span>
      </div>
    </main>
    <script>
      const COLS = 100;
      const ROWS = 60;
      const CELL = 6;
      const canvas = document.getElementById('board');
      const context = canvas.getContext('2d');
      const readouts = {
        generation: document.getElementById('generation'),
        alive: document.getElementById('alive'),
        born: document.getElementById('born'),
        died: document.getElementById('died'),
      };

      // Cell values are ages: 0 is dead, 1 is newborn, higher is a survivor.
      let cells = new Uint16Array(COLS * ROWS);
      let generation = 0;
      let born = 0;
      let died = 0;
      let timer = 0;

      const PATTERNS = {
        gun: [
          [0, 4], [0, 5], [1, 4], [1, 5], [10, 4], [10, 5], [10, 6], [11, 3], [11, 7],
          [12, 2], [12, 8], [13, 2], [13, 8], [14, 5], [15, 3], [15, 7], [16, 4], [16, 5],
          [16, 6], [17, 5], [20, 2], [20, 3], [20, 4], [21, 2], [21, 3], [21, 4], [22, 1],
          [22, 5], [24, 0], [24, 1], [24, 5], [24, 6], [34, 2], [34, 3], [35, 2], [35, 3],
        ],
        pulsar: [
          [2, 0], [3, 0], [4, 0], [8, 0], [9, 0], [10, 0], [0, 2], [5, 2], [7, 2], [12, 2],
          [0, 3], [5, 3], [7, 3], [12, 3], [0, 4], [5, 4], [7, 4], [12, 4], [2, 5], [3, 5],
          [4, 5], [8, 5], [9, 5], [10, 5], [2, 7], [3, 7], [4, 7], [8, 7], [9, 7], [10, 7],
          [0, 8], [5, 8], [7, 8], [12, 8], [0, 9], [5, 9], [7, 9], [12, 9], [0, 10],
          [5, 10], [7, 10], [12, 10], [2, 12], [3, 12], [4, 12], [8, 12], [9, 12], [10, 12],
        ],
        pentomino: [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]],
      };

      function index(x, y) {
        return ((y + ROWS) % ROWS) * COLS + ((x + COLS) % COLS);
      }

      function seed(name) {
        cells = new Uint16Array(COLS * ROWS);
        generation = 0;
        born = 0;
        died = 0;
        if (name === 'soup') {
          for (let i = 0; i < cells.length; i += 1) cells[i] = Math.random() < 0.3 ? 1 : 0;
        } else {
          // An unknown name (the Clear button) seeds nothing, leaving an empty grid.
          const shape = PATTERNS[name] ?? [];
          const offsetX = Math.floor((COLS - Math.max(1, ...shape.map(([x]) => x + 1))) / 2);
          const offsetY = Math.floor((ROWS - Math.max(1, ...shape.map(([, y]) => y + 1))) / 2);
          for (const [x, y] of shape) cells[index(x + offsetX, y + offsetY)] = 1;
        }
        draw();
      }

      function neighbours(x, y) {
        let count = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            if (cells[index(x + dx, y + dy)] > 0) count += 1;
          }
        }
        return count;
      }

      function advance() {
        const next = new Uint16Array(cells.length);
        for (let y = 0; y < ROWS; y += 1) {
          for (let x = 0; x < COLS; x += 1) {
            const at = index(x, y);
            const age = cells[at];
            const live = neighbours(x, y);
            if (age > 0 && (live === 2 || live === 3)) next[at] = Math.min(age + 1, 400);
            else if (age === 0 && live === 3) {
              next[at] = 1;
              born += 1;
            } else if (age > 0) died += 1;
          }
        }
        cells = next;
        generation += 1;
        draw();
      }

      function draw() {
        context.fillStyle = '#05060b';
        context.fillRect(0, 0, canvas.width, canvas.height);
        let alive = 0;
        for (let y = 0; y < ROWS; y += 1) {
          for (let x = 0; x < COLS; x += 1) {
            const age = cells[index(x, y)];
            if (age === 0) continue;
            alive += 1;
            const heat = Math.min(age, 24) / 24;
            const hue = 190 - heat * 150;
            context.fillStyle = 'hsl(' + hue + ' 90% ' + (54 + heat * 12) + '%)';
            context.fillRect(x * CELL, y * CELL, CELL - 1, CELL - 1);
          }
        }
        readouts.generation.textContent = String(generation);
        readouts.alive.textContent = String(alive);
        readouts.born.textContent = String(born);
        readouts.died.textContent = String(died);
      }

      function stop() {
        clearInterval(timer);
        timer = 0;
        document.getElementById('toggle').textContent = 'Play';
      }

      function start() {
        if (timer !== 0) return;
        timer = setInterval(advance, 90);
        document.getElementById('toggle').textContent = 'Pause';
      }

      function paintAt(event) {
        const bounds = canvas.getBoundingClientRect();
        const x = Math.floor(((event.clientX - bounds.left) / bounds.width) * COLS);
        const y = Math.floor(((event.clientY - bounds.top) / bounds.height) * ROWS);
        cells[index(x, y)] = 1;
        draw();
      }

      canvas.addEventListener('pointerdown', (event) => {
        canvas.setPointerCapture(event.pointerId);
        paintAt(event);
      });
      canvas.addEventListener('pointermove', (event) => {
        if (event.buttons === 1) paintAt(event);
      });
      document.getElementById('toggle').addEventListener('click', () => {
        if (timer === 0) start();
        else stop();
      });
      document.getElementById('step').addEventListener('click', () => {
        stop();
        advance();
      });
      document.getElementById('clear').addEventListener('click', () => {
        stop();
        seed('clear');
      });
      document.getElementById('pattern').addEventListener('change', (event) => {
        seed(event.target.value);
        start();
      });

      seed('gun');
      start();
    </script>
  </body>
</html>`;

const REACT_BUDGET = `import { useEffect, useMemo, useReducer, useState } from 'react';
import confetti from 'canvas-confetti';

const CATEGORIES = [
  { id: 'infra', label: 'Infrastructure', colour: '#7aa7ff' },
  { id: 'tools', label: 'Tooling', colour: '#ffd166' },
  { id: 'people', label: 'Contractors', colour: '#ef476f' },
  { id: 'growth', label: 'Growth', colour: '#06d6a0' },
];

const STARTING_ENTRIES = [
  { id: 1, label: 'Workers + Durable Objects', category: 'infra', amount: 320 },
  { id: 2, label: 'Postgres', category: 'infra', amount: 210 },
  { id: 3, label: 'Design tooling', category: 'tools', amount: 140 },
  { id: 4, label: 'Illustrator, part-time', category: 'people', amount: 900 },
  { id: 5, label: 'Conference booth', category: 'growth', amount: 480 },
];

const STYLES = \`
  .budget { box-sizing: border-box; min-height: 100vh; padding: 24px; display: flex;
    flex-direction: column; gap: 16px; color: #eef2ff; font-family: ui-sans-serif, system-ui, sans-serif;
    background: linear-gradient(160deg, #101728 0%, #0a0d17 70%); }
  .budget h1 { margin: 0; font-size: 1.2rem; }
  .budget .lead { margin: 0; font-size: 0.85rem; color: #94a3c4; }
  .budget .top { display: flex; flex-wrap: wrap; align-items: center; gap: 20px; }
  .budget .donut { width: 150px; height: 150px; }
  .budget .donut-track { fill: none; stroke: rgba(255, 255, 255, 0.07); stroke-width: 14; }
  .budget .donut-slice { fill: none; stroke-width: 14; transition: stroke-dasharray 240ms ease; }
  .budget .donut-value { fill: #eef2ff; font-size: 17px; text-anchor: middle; font-weight: 600; }
  .budget .donut-label { fill: #94a3c4; font-size: 9px; text-anchor: middle; letter-spacing: 0.08em; }
  .budget .tiles { display: flex; flex-wrap: wrap; gap: 12px; }
  .budget .tile { min-width: 120px; padding: 12px 16px; border-radius: 14px;
    border: 1px solid rgba(255, 255, 255, 0.09); background: rgba(255, 255, 255, 0.04);
    display: flex; flex-direction: column; gap: 4px; }
  .budget .tile-label { font-size: 0.7rem; letter-spacing: 0.09em; text-transform: uppercase; color: #94a3c4; }
  .budget .tile-value { font-size: 1.35rem; font-variant-numeric: tabular-nums; }
  .budget .good .tile-value { color: #06d6a0; }
  .budget .bad .tile-value { color: #ef476f; }
  .budget .bars { display: flex; flex-direction: column; gap: 8px; }
  .budget .bar-row { display: grid; grid-template-columns: 130px 1fr 74px; align-items: center;
    gap: 12px; font-size: 0.85rem; }
  .budget .bar-track { height: 8px; border-radius: 99px; background: rgba(255, 255, 255, 0.07); }
  .budget .bar-fill { height: 100%; border-radius: 99px; transition: width 240ms ease; }
  .budget .amount { text-align: right; font-variant-numeric: tabular-nums; color: #94a3c4; }
  .budget form, .budget .slider { display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
    font-size: 0.85rem; color: #94a3c4; }
  .budget input, .budget select, .budget button { font: inherit; color: #eef2ff;
    background: rgba(255, 255, 255, 0.07); border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 10px; padding: 7px 12px; }
  .budget input[type='range'] { padding: 0; border: 0; background: none; flex: 1; min-width: 140px; }
  .budget button { cursor: pointer; border-radius: 999px; }
  .budget button:disabled { opacity: 0.45; cursor: not-allowed; }
  .budget ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .budget li { display: grid; grid-template-columns: 10px 1fr auto auto 28px; align-items: center;
    gap: 12px; padding: 9px 12px; border-radius: 12px; background: rgba(255, 255, 255, 0.04);
    font-size: 0.85rem; }
  .budget .dot { width: 10px; height: 10px; border-radius: 99px; }
  .budget .muted { color: #94a3c4; font-size: 0.78rem; }
  .budget .ghost { padding: 2px 8px; background: none; border: 0; color: #94a3c4; font-size: 1rem; }
  .budget .ghost:hover { color: #ef476f; }
\`;

function money(value) {
  return '$' + Math.round(value).toLocaleString('en-US');
}

function categoryOf(id) {
  return CATEGORIES.find((category) => category.id === id) ?? CATEGORIES[0];
}

function entriesReducer(entries, action) {
  if (action.type === 'add') return [...entries, { ...action.entry, id: Date.now() }];
  if (action.type === 'remove') return entries.filter((entry) => entry.id !== action.id);
  return entries;
}

function Donut({ slices, total }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  let travelled = 0;
  return (
    <svg viewBox="0 0 140 140" className="donut" role="img" aria-label="Spend by category">
      <circle className="donut-track" cx="70" cy="70" r={radius} />
      <g transform="rotate(-90 70 70)">
        {slices.map((slice) => {
          const length = total === 0 ? 0 : (slice.amount / total) * circumference;
          const offset = travelled;
          travelled += length;
          return (
            <circle
              key={slice.id}
              className="donut-slice"
              cx="70"
              cy="70"
              r={radius}
              stroke={slice.colour}
              strokeDasharray={length + ' ' + (circumference - length)}
              strokeDashoffset={-offset}
            />
          );
        })}
      </g>
      <text className="donut-value" x="70" y="70">
        {money(total)}
      </text>
      <text className="donut-label" x="70" y="86">
        PER MONTH
      </text>
    </svg>
  );
}

function Tile({ label, value, tone }) {
  return (
    <div className={'tile ' + tone}>
      <span className="tile-label">{label}</span>
      <strong className="tile-value">{value}</strong>
    </div>
  );
}

function EntryForm({ onAdd }) {
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState(CATEGORIES[0].id);
  const ready = label.trim().length > 0 && Number(amount) > 0;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        onAdd({ label: label.trim(), amount: Number(amount), category });
        setLabel('');
        setAmount('');
      }}
    >
      <input
        value={label}
        placeholder="New line item"
        onChange={(event) => setLabel(event.target.value)}
      />
      <input
        value={amount}
        type="number"
        min="1"
        placeholder="0"
        onChange={(event) => setAmount(event.target.value)}
      />
      <select value={category} onChange={(event) => setCategory(event.target.value)}>
        {CATEGORIES.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <button type="submit" disabled={!ready}>
        Add
      </button>
    </form>
  );
}

export default function Runway() {
  const [entries, dispatch] = useReducer(entriesReducer, STARTING_ENTRIES);
  const [budget, setBudget] = useState(1800);

  const total = useMemo(
    () => entries.reduce((sum, entry) => sum + entry.amount, 0),
    [entries]
  );
  const slices = useMemo(
    () =>
      CATEGORIES.map((category) => ({
        ...category,
        amount: entries
          .filter((entry) => entry.category === category.id)
          .reduce((sum, entry) => sum + entry.amount, 0),
      })).filter((slice) => slice.amount > 0),
    [entries]
  );

  const remaining = budget - total;
  const withinBudget = remaining >= 0;

  // Fires only on the crossing, and the seeded month starts over budget — so the
  // celebration belongs to something the reader did, never to the first paint.
  useEffect(() => {
    if (!withinBudget) return;
    confetti({ particleCount: 130, spread: 72, origin: { y: 0.65 } });
  }, [withinBudget]);

  return (
    <main className="budget">
      <style>{STYLES}</style>
      <h1>Monthly run-rate</h1>
      <p className="lead">
        Drop a line item, move the budget, and the whole board recomputes. Land under budget for a
        small celebration.
      </p>

      <div className="top">
        <Donut slices={slices} total={total} />
        <div className="tiles">
          <Tile label="spending" value={money(total)} tone="calm" />
          <Tile label="budget" value={money(budget)} tone="calm" />
          <Tile
            label={withinBudget ? 'left over' : 'over budget'}
            value={money(Math.abs(remaining))}
            tone={withinBudget ? 'good' : 'bad'}
          />
        </div>
      </div>

      <div className="bars">
        {slices.map((slice) => (
          <div className="bar-row" key={slice.id}>
            <span>{slice.label}</span>
            <div className="bar-track">
              <div
                className="bar-fill"
                style={{
                  width: (total === 0 ? 0 : (slice.amount / total) * 100) + '%',
                  background: slice.colour,
                }}
              />
            </div>
            <span className="amount">{money(slice.amount)}</span>
          </div>
        ))}
      </div>

      <label className="slider">
        budget
        <input
          type="range"
          min="800"
          max="3200"
          step="50"
          value={budget}
          onChange={(event) => setBudget(Number(event.target.value))}
        />
        <span className="amount">{money(budget)}</span>
      </label>

      <EntryForm onAdd={(entry) => dispatch({ type: 'add', entry })} />

      <ul>
        {entries.map((entry) => (
          <li key={entry.id}>
            <span className="dot" style={{ background: categoryOf(entry.category).colour }} />
            <span>{entry.label}</span>
            <span className="muted">{categoryOf(entry.category).label}</span>
            <span className="amount">{money(entry.amount)}</span>
            <button
              type="button"
              className="ghost"
              aria-label={'Remove ' + entry.label}
              onClick={() => dispatch({ type: 'remove', id: entry.id })}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}`;

const PYTHON_ANALYSIS = `import numpy as np
import matplotlib.pyplot as plt

# Twelve weeks of signups per region, straight out of the warehouse export.
regions = ["North", "South", "East", "West"]
colours = ["#4c78a8", "#f58518", "#54a24b", "#e45756"]
weeks = np.arange(1, 13)
signups = np.array(
    [
        [120, 133, 129, 145, 160, 158, 172, 181, 190, 205, 214, 232],
        [88, 92, 96, 91, 104, 118, 121, 130, 128, 141, 150, 162],
        [210, 205, 198, 221, 219, 232, 244, 238, 259, 266, 271, 288],
        [54, 61, 59, 72, 80, 77, 91, 99, 104, 112, 121, 133],
    ]
)

totals = signups.sum(axis=1)
averages = signups.mean(axis=1)
growth = (signups[:, -1] - signups[:, 0]) / signups[:, 0] * 100
slopes = np.zeros(len(regions))
fits = np.zeros_like(signups, dtype=float)

header = f"{'region':<8}{'total':>7}{'avg/wk':>9}{'growth':>9}{'trend':>8}{'R2':>7}"
print(header)
print("-" * len(header))

for i, region in enumerate(regions):
    slope, intercept = np.polyfit(weeks, signups[i], 1)
    fits[i] = slope * weeks + intercept
    residuals = signups[i] - fits[i]
    r2 = 1 - residuals.var() / signups[i].var()
    slopes[i] = slope
    print(
        f"{region:<8}{totals[i]:>7}{averages[i]:>9.1f}"
        f"{growth[i]:>8.1f}%{slope:>8.1f}{r2:>7.3f}"
    )

network = signups.sum(axis=0)
fastest = int(np.argmax(slopes))
print()
print(f"fastest climb: {regions[fastest]}, +{slopes[fastest]:.1f} signups per week")
print(f"network total: {int(network.sum())} signups across {weeks.size} weeks")
print(f"weekly change: mean {np.diff(network).mean():.1f}, sd {np.diff(network).std():.1f}")

fig, (series, bars) = plt.subplots(1, 2, figsize=(9.5, 3.8))
for i, region in enumerate(regions):
    series.plot(weeks, signups[i], marker="o", markersize=3, color=colours[i], label=region)
    series.plot(weeks, fits[i], linestyle="--", linewidth=0.9, color=colours[i], alpha=0.6)
series.set_title("Weekly signups, with least-squares trend")
series.set_xlabel("week")
series.set_ylabel("signups")
series.legend(fontsize=7)

bars.bar(regions, totals, color=colours)
bars.axhline(totals.mean(), linestyle="--", color="0.4", linewidth=1)
bars.set_title("Twelve-week totals")
bars.set_ylabel("signups")
fig.tight_layout()`;

const JS_SORTING_LAB = `const algorithms = {
  'Bubble sort': function* bubbleSort(values) {
    for (let end = values.length - 1; end > 0; end -= 1) {
      let swapped = false;
      for (let i = 0; i < end; i += 1) {
        yield ['compare', i, i + 1];
        if (values[i] > values[i + 1]) {
          [values[i], values[i + 1]] = [values[i + 1], values[i]];
          yield ['swap', i, i + 1];
          swapped = true;
        }
      }
      if (!swapped) return;
    }
  },
  'Insertion sort': function* insertionSort(values) {
    for (let i = 1; i < values.length; i += 1) {
      for (let j = i; j > 0; j -= 1) {
        yield ['compare', j - 1, j];
        if (values[j - 1] <= values[j]) break;
        [values[j - 1], values[j]] = [values[j], values[j - 1]];
        yield ['swap', j - 1, j];
      }
    }
  },
  'Selection sort': function* selectionSort(values) {
    for (let i = 0; i < values.length - 1; i += 1) {
      let low = i;
      for (let j = i + 1; j < values.length; j += 1) {
        yield ['compare', low, j];
        if (values[j] < values[low]) low = j;
      }
      if (low !== i) {
        [values[i], values[low]] = [values[low], values[i]];
        yield ['swap', i, low];
      }
    }
  },
  Quicksort: function* quicksort(values, low = 0, high = values.length - 1) {
    if (low >= high) return;
    const pivot = values[high];
    let cut = low;
    for (let i = low; i < high; i += 1) {
      yield ['compare', i, high];
      if (values[i] < pivot) {
        [values[i], values[cut]] = [values[cut], values[i]];
        yield ['swap', i, cut];
        cut += 1;
      }
    }
    [values[cut], values[high]] = [values[high], values[cut]];
    yield ['swap', cut, high];
    yield* quicksort(values, low, cut - 1);
    yield* quicksort(values, cut + 1, high);
  },
};

const BAR_COUNT = 48;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const style = el('style');
style.textContent = \`
  .lab { box-sizing: border-box; min-height: 100vh; padding: 24px; display: flex;
    flex-direction: column; gap: 14px; color: #e6ecff; font-family: ui-sans-serif, system-ui, sans-serif;
    background: radial-gradient(circle at 15% 0%, #22305c 0%, #0b1020 62%); }
  .lab h1 { margin: 0; font-size: 1.2rem; letter-spacing: 0.01em; }
  .lab p { margin: 0; font-size: 0.85rem; color: #93a4cc; }
  .lab .track { flex: 1; min-height: 200px; display: flex; align-items: flex-end; gap: 2px;
    padding: 10px; border-radius: 14px; background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.09); }
  .lab .bar { flex: 1; border-radius: 3px 3px 0 0; transition: height 90ms linear;
    background: linear-gradient(180deg, #7aa7ff, #3b6fd4); }
  .lab .bar.compare { background: #ffd166; }
  .lab .bar.swap { background: #ef476f; }
  .lab .bar.done { background: #06d6a0; }
  .lab .row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .lab button, .lab select, .lab input { font: inherit; color: inherit; cursor: pointer;
    background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.18); }
  .lab button, .lab select { border-radius: 999px; padding: 6px 14px; }
  .lab input[type='range'] { padding: 0; border: 0; background: none; }
  .lab button:hover, .lab select:hover { background: rgba(255, 255, 255, 0.16); }
  .lab .stats { display: flex; flex-wrap: wrap; gap: 18px; font-size: 0.85rem;
    color: #93a4cc; font-variant-numeric: tabular-nums; }
  .lab .stats b { color: #e6ecff; font-weight: 600; }
\`;

const shell = el('div', 'lab');
const track = el('div', 'track');
const controls = el('div', 'row');
const readout = el('div', 'stats');

const choice = el('select');
for (const name of Object.keys(algorithms)) choice.append(new Option(name, name));
const playButton = el('button', undefined, 'Pause');
const shuffleButton = el('button', undefined, 'Shuffle');
const speed = el('input');
speed.type = 'range';
speed.min = '1';
speed.max = '24';
speed.value = '6';

controls.append(choice, playButton, shuffleButton, el('span', undefined, 'speed'), speed);
shell.append(
  el('h1', undefined, 'Sorting visualiser'),
  el('p', undefined, 'Four algorithms written as generators, stepped one comparison at a time.'),
  track,
  controls,
  readout
);
document.querySelector('#document-root').replaceChildren(style, shell);

let values = [];
let bars = [];
let steps = null;
let marks = new Map();
let comparisons = 0;
let swaps = 0;
let sorted = false;
let timer = 0;

function stat(label, value) {
  const wrap = el('span', undefined, label + ' ');
  wrap.append(el('b', undefined, value));
  return wrap;
}

function report(state) {
  readout.replaceChildren(
    stat('algorithm', choice.value),
    stat('comparisons', String(comparisons)),
    stat('swaps', String(swaps)),
    stat('status', state)
  );
}

function paint() {
  bars.forEach((bar, index) => {
    bar.style.height = String((values[index] / BAR_COUNT) * 100) + '%';
    const mark = sorted ? 'done' : marks.get(index);
    bar.className = mark === undefined ? 'bar' : 'bar ' + mark;
  });
}

function advance() {
  const step = steps.next();
  if (step.done) {
    sorted = true;
    marks = new Map();
    return false;
  }
  const [kind, a, b] = step.value;
  marks = new Map([
    [a, kind],
    [b, kind],
  ]);
  if (kind === 'compare') comparisons += 1;
  else swaps += 1;
  return true;
}

function tick() {
  for (let i = 0; i < Number(speed.value); i += 1) {
    if (!advance()) {
      paint();
      pause();
      report('sorted');
      return;
    }
  }
  paint();
  report('sorting');
  timer = setTimeout(tick, 16);
}

function pause() {
  clearTimeout(timer);
  timer = 0;
  playButton.textContent = 'Play';
}

function play() {
  // Playing a finished run starts a fresh one, so the button is never dead.
  if (sorted) shuffle();
  if (steps === null) steps = algorithms[choice.value](values);
  if (timer !== 0) return;
  playButton.textContent = 'Pause';
  tick();
}

function shuffle() {
  pause();
  values = Array.from({ length: BAR_COUNT }, (unused, index) => index + 1);
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  bars = values.map(() => el('div', 'bar'));
  track.replaceChildren(...bars);
  steps = null;
  marks = new Map();
  comparisons = 0;
  swaps = 0;
  sorted = false;
  paint();
  report('ready');
}

playButton.addEventListener('click', () => {
  if (timer === 0) play();
  else pause();
});
shuffleButton.addEventListener('click', () => {
  shuffle();
  play();
});
choice.addEventListener('change', () => {
  shuffle();
  play();
});

shuffle();
play();`;

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

const REACT_COMPILE_ERROR = `const failsToCompileOnPurpose =
  'Broken on purpose: this file is written so the transpiler rejects it.';

const stages = ['parse', 'transpile', 'render'];

export default function Pipeline() {
  return (
    <section>
      <h1>Compile failure, on purpose</h1>
      <p>{failsToCompileOnPurpose}</p>
      <p>Nothing is wrong with the panel: this is the card a bad document should produce.</p>
      <ul>
        {stages.map((stage) => (
          <li key={stage}>{stage}</li>
        ))}
      </ul>
      <footer>
        <small>The element below is never closed, so the file never reaches the renderer.</small>
      <div>
    </section>
  );
}`;

const REACT_RUNTIME_ERROR = `const failsToMountOnPurpose =
  'Broken on purpose: this file compiles cleanly and throws while mounting.';

const config = {
  title: 'Runtime failure, on purpose',
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
      <p>{failsToMountOnPurpose}</p>
      <p>Nothing is wrong with the panel: this is the card a throwing document should produce.</p>
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
 * message. Order matches the panel's paths — the four runnable kinds (html,
 * react, js, python), the in-app diagram, the two deliberate failure cards, and
 * a block that must stay plain code.
 */
export const DOCUMENT_SHOWCASE_MESSAGES: readonly {
  content: string;
  senderType: 'user' | 'ai';
}[] = [
  {
    senderType: 'user',
    content:
      'Show me what the document panel can do — one document per reply, covering HTML, React, plain JavaScript, Python, diagrams, and what happens when a document is broken.',
  },
  {
    senderType: 'ai',
    content: fenced(
      "A whole HTML page: Conway's Game of Life on a canvas, with seed patterns and live counters.",
      'html',
      HTML_LIFE
    ),
  },
  {
    senderType: 'ai',
    content: fenced(
      'A React dashboard — several components, a reducer, an inline SVG chart, and canvas-confetti straight from npm.',
      'jsx',
      REACT_BUDGET
    ),
  },
  {
    senderType: 'ai',
    content: fenced(
      'A plain JavaScript module, no framework: it builds its own DOM and races four sorting algorithms.',
      'js',
      JS_SORTING_LAB
    ),
  },
  {
    senderType: 'ai',
    content: fenced(
      'Python with numpy and matplotlib — press Run for the fitted table and a two-panel figure.',
      'python',
      PYTHON_ANALYSIS
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
      'Broken on purpose, not a bug: an unclosed tag, so the compile-failure card is what should appear.',
      'jsx',
      REACT_COMPILE_ERROR
    ),
  },
  {
    senderType: 'ai',
    content: fenced(
      'Broken on purpose too: this one compiles, then throws while mounting — the other failure card.',
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
