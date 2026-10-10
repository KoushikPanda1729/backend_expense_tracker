#!/usr/bin/env bash
# Deploy the backend straight from this machine to your server over SSH. No git, no registry:
# the folder is copied and the image is built on the server.
#
#   ./deploy/deploy.sh ubuntu@1.2.3.4 [-i ~/.ssh/key.pem] [--setup]
#
# --setup   first time only: installs Docker + swap on the server
# Needs backend/.env.production (copy .env.production.example and fill it in).
set -euo pipefail

HOST="${1:?usage: deploy.sh user@host [-i key.pem] [--setup]}"; shift || true
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)
SETUP=0
while [ $# -gt 0 ]; do
  case "$1" in
    -i) SSH_OPTS+=(-i "$2"); shift 2 ;;
    --setup) SETUP=1; shift ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
done

cd "$(dirname "$0")/.."
[ -f .env.production ] || { echo "missing .env.production (copy .env.production.example and fill it in)"; exit 1; }
grep -qE '^(JWT_ACCESS_SECRET|ENCRYPTION_KEY)=$' .env.production && { echo "fill in JWT_ACCESS_SECRET and ENCRYPTION_KEY in .env.production"; exit 1; }

ssh_run() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }

if [ "$SETUP" = 1 ]; then
  echo "==> setting up the server (Docker, swap)"
  ssh "${SSH_OPTS[@]}" "$HOST" 'bash -s' < deploy/setup-server.sh
fi

echo "==> copying the backend"
rsync -az --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  --exclude /node_modules --exclude /dist --exclude /storage --exclude /.git \
  --exclude /.env --exclude /.env.local --exclude /test --exclude '*.log' \
  ./ "$HOST:/opt/kharcha/"

echo "==> building and starting (this builds the image on the server)"
ssh_run 'cd /opt/kharcha && chmod 600 .env.production && docker compose --env-file .env.production up -d --build --remove-orphans'

echo "==> waiting for the API"
for i in $(seq 1 30); do
  if ssh_run 'curl -fsS http://127.0.0.1:4000/ready' >/dev/null 2>&1; then
    echo "API is up and the database answers (GET /ready)."
    exit 0
  fi
  sleep 2
done
echo "API did not become ready. Logs:"; ssh_run 'cd /opt/kharcha && docker compose --env-file .env.production logs --tail=40 api'
exit 1
