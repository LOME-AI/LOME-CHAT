#!/usr/bin/env bash
# Reproduces the self-hosted Pyodide 314.0.2 asset set the spike serves from the
# sandbox origin (NOT loaded from any public CDN at runtime — R1). The heavy
# binaries are stripped from the run record to avoid ~26 MB of repo bloat; run
# this to regenerate sandbox/pyodide/ before re-running the spike.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)/sandbox/pyodide"
mkdir -p "$DIR"; cd "$DIR"

# Core runtime: fetched from the npm package tarball so the loader, glue, wasm,
# stdlib and lock file are a matched set (the v314 CDN dropped the standalone
# pyodide.asm.js layout — core files differ from wheels host).
TMP="$(mktemp -d)"; ( cd "$TMP" && npm pack pyodide@314.0.2 >/dev/null && tar xzf pyodide-314.0.2.tgz )
cp "$TMP/package/"{pyodide.mjs,pyodide.js,pyodide.asm.mjs,pyodide.asm.wasm,python_stdlib.zip,pyodide-lock.json} .
rm -rf "$TMP"

# numpy + matplotlib (+ transitive deps) wheels from the versioned CDN dir.
BASE="https://cdn.jsdelivr.net/pyodide/v314.0.2/full"
for w in \
  numpy-2.4.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl \
  matplotlib-3.10.8-cp314-cp314-pyemscripten_2026_0_wasm32.whl \
  contourpy-1.3.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl \
  cycler-0.12.1-py3-none-any.whl \
  six-1.17.0-py2.py3-none-any.whl \
  fonttools-4.62.1-py3-none-any.whl \
  kiwisolver-1.5.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl \
  packaging-26.1-py3-none-any.whl \
  pillow-12.2.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl \
  pyparsing-3.3.2-py3-none-any.whl \
  python_dateutil-2.9.0.post0-py2.py3-none-any.whl \
  pytz-2026.1.post1-py2.py3-none-any.whl ; do
  curl -sSL -O "$BASE/$w"
done
echo "pyodide assets restored to $DIR ($(du -sh . | cut -f1))"
