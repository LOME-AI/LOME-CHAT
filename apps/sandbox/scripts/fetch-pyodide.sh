#!/usr/bin/env bash
# Committed, pinned fetch mechanism for the self-hosted Pyodide 314.0.2 asset
# set the sandbox origin serves from /pyodide/. Self-hosted so that nothing is
# loaded from a public CDN at RUNTIME; the CDN is touched only here, at build
# time. The ~26 MB of wasm/wheels are gitignored (see ../.gitignore) and
# regenerated from this script rather than committed; this file is the source of
# truth for exactly which pinned bytes land under public/pyodide/.
#
# Run: pnpm --filter @hushbox/sandbox fetch-pyodide
#
# The wheel set below (numpy + matplotlib + their transitive deps) is a baseline;
# the runtime's loadPackagesFromImports/micropip path needs the definitive list,
# which is extended here as new imports require it.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)/../public/pyodide"
mkdir -p "$DIR"
cd "$DIR"

# Idempotent: the sandbox test suite depends on this task, and CI restores the
# asset set from cache, so skip the ~26 MB re-download when the pinned closure is
# already present. A sentinel of the core runtime plus the last wheel in the list
# stands for a complete set (each file is written whole by curl -O).
if [ -f pyodide.asm.wasm ] && [ -f pyodide-lock.json ] && [ -f micropip-0.11.1-py3-none-any.whl ]; then
  echo "pyodide assets already present in $DIR — skipping fetch"
  exit 0
fi

# Core runtime: taken from the npm package tarball so the loader, glue, wasm,
# stdlib and lock file are a matched set (the v314 CDN dropped the standalone
# pyodide.asm.js layout — the core files differ from the wheels host).
TMP="$(mktemp -d)"
(cd "$TMP" && npm pack pyodide@314.0.2 >/dev/null && tar xzf pyodide-314.0.2.tgz)
cp "$TMP/package/"{pyodide.mjs,pyodide.js,pyodide.asm.mjs,pyodide.asm.wasm,python_stdlib.zip,pyodide-lock.json} .
rm -rf "$TMP"

# The complete self-hosted wheel closure of numpy + matplotlib + micropip, read
# from pyodide-lock.json (matplotlib pulls contourpy/cycler/fonttools/kiwisolver/
# packaging/pillow/pyparsing/dateutil/pytz; micropip pulls packaging). Every
# transitive dependency must be present or loadPackagesFromImports 404s at
# runtime. Pinned filenames only; never a floating tag. When a new import needs a
# package, add its lock filename (and any new transitive deps) here.
BASE="https://cdn.jsdelivr.net/pyodide/v314.0.2/full"
for w in \
  numpy-2.4.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl \
  matplotlib-3.10.8-cp314-cp314-pyemscripten_2026_0_wasm32.whl \
  contourpy-1.3.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl \
  cycler-0.12.1-py3-none-any.whl \
  six-1.17.0-py2.py3-none-any.whl \
  fonttools-4.62.1-py3-none-any.whl \
  kiwisolver-1.5.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl \
  pillow-12.2.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl \
  packaging-26.1-py3-none-any.whl \
  pyparsing-3.3.2-py3-none-any.whl \
  python_dateutil-2.9.0.post0-py2.py3-none-any.whl \
  pytz-2026.1.post1-py2.py3-none-any.whl \
  micropip-0.11.1-py3-none-any.whl; do
  curl -sSL -O "$BASE/$w"
done
echo "pyodide assets restored to $DIR ($(du -sh . | cut -f1))"
