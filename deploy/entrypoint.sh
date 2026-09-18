#!/bin/sh
set -e

cd /app/apps/server

cat > .dev.vars <<EOF
REGISTRATION_ENABLED=${REGISTRATION_ENABLED:-true}
INVITE_CODES=${INVITE_CODES:-}
ENVIRONMENT=${ENVIRONMENT:-production}
EOF

echo "==> Applying D1 migrations..."
npx wrangler d1 migrations apply DB --local --persist-to .wrangler/state/data

echo "==> Starting wrangler dev (API on :8787)..."
npx wrangler dev --port 8787 --ip 127.0.0.1 --persist-to .wrangler/state/data &

sleep 3

echo "==> Starting nginx (frontend on :80)..."
nginx -g 'daemon off;'
