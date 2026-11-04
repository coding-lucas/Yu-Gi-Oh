#!/usr/bin/env bash
# Builds the static demo (GitHub Pages) into apps/web/out. Usage: BASE_PATH=/Yu-Gi-Oh scripts/build-static-demo.sh
set -euo pipefail
cd "$(dirname "$0")/.."
BASE_PATH="${BASE_PATH:-}"
ASIDE="$(mktemp -d)"
restore() { [ -f "$ASIDE/middleware.ts" ] && mv "$ASIDE/middleware.ts" src/; [ -d "$ASIDE/id" ] && mv "$ASIDE/id" "src/app/[locale]/match/[id]"; rm -rf "$ASIDE"; }
trap restore EXIT
# static export supports neither middleware nor un-enumerable dynamic routes
mv src/middleware.ts "$ASIDE/"
mv "src/app/[locale]/match/[id]" "$ASIDE/id"
rm -rf .next out
NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_STATIC_DEMO=1 NEXT_PUBLIC_BASE_PATH="$BASE_PATH" npx next build
# language detection at the root + SPA-friendly 404
cat > out/index.html <<HTML
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AthosBet</title>
<script>var l=['pt','en','es','fr','de','it','ar','hi','zh','ja','ko'],n=(navigator.language||'pt').slice(0,2).toLowerCase();location.replace('${BASE_PATH}/'+(l.indexOf(n)>=0?n:'pt')+'/');</script>
</head><body style="background:#090D12"></body></html>
HTML
cp out/index.html out/404.html
touch out/.nojekyll
echo "static demo built in apps/web/out"
