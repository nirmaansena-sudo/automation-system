#!/usr/bin/env sh
# Mac / Linux start script.  Usage: ./start.sh        (n8n: ./start.sh n8n)
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then echo "Install Node.js 22.13+ from https://nodejs.org"; exit 1; fi
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" || { echo "Node.js 22.13 or newer is required"; exit 1; }
[ -f .env ] || cp .env.example .env
[ -f node_modules/h3-js/package.json ] || npm ci --omit=dev --ignore-scripts --no-fund || exit 1
if [ "$1" = "n8n" ]; then
  eval "$(node scripts/n8n-env.js sh)"
  exec npx --yes n8n
fi
exec node --disable-warning=ExperimentalWarning server/main.js --open
