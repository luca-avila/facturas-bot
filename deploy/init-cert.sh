#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.prod.yml"
ENV_FILE="${ROOT_DIR}/.env.production"
STAGING=0

usage() {
  cat <<'EOF'
Usage: deploy/init-cert.sh [--env-file <path>] [--staging]

Issues the first Let's Encrypt certificate via Certbot HTTP-01 webroot,
restarts nginx into HTTPS mode, and starts the certbot renewal service.

Options:
  --env-file <path>  Path to the production env file (default: .env.production)
  --staging          Use Let's Encrypt staging CA (for testing DNS/ACME without rate limits)
  -h, --help         Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file)
      [ "$#" -ge 2 ] || { echo "ERROR: --env-file requires a path." >&2; usage >&2; exit 1; }
      ENV_FILE="$2"
      shift 2
      ;;
    --staging)
      STAGING=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: Env file not found: $ENV_FILE" >&2
  echo "Copy .env.production.example to .env.production and fill in all values first." >&2
  exit 1
fi

read_env_var() {
  local key="$1"
  local line value
  line="$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" | tail -n 1 || true)"
  value="${line#*=}"
  value="${value%$'\r'}"
  value="${value#\"}"
  value="${value%\"}"
  value="${value#\'}"
  value="${value%\'}"
  printf '%s' "$value"
}

APP_DOMAIN="$(read_env_var APP_DOMAIN)"
CERTBOT_EMAIL="$(read_env_var CERTBOT_EMAIL)"

if [ -z "$APP_DOMAIN" ] || [ "$APP_DOMAIN" = "facturas.example.com" ]; then
  echo "ERROR: Set APP_DOMAIN to your real domain in $ENV_FILE." >&2
  exit 1
fi

if [ -z "$CERTBOT_EMAIL" ] || [ "$CERTBOT_EMAIL" = "admin@example.com" ]; then
  echo "ERROR: Set CERTBOT_EMAIL to your real email address in $ENV_FILE." >&2
  exit 1
fi

compose() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

echo "==> Starting nginx on port 80 for ACME HTTP-01 challenge..."
compose up -d --no-deps --build nginx

CERTBOT_ARGS=(
  certonly
  --webroot
  -w /var/www/certbot
  -d "$APP_DOMAIN"
  --email "$CERTBOT_EMAIL"
  --agree-tos
  --no-eff-email
  --non-interactive
)

if [ "$STAGING" -eq 1 ]; then
  echo "==> Using Let's Encrypt staging environment (--staging)."
  CERTBOT_ARGS+=(--staging)
fi

echo "==> Requesting Let's Encrypt certificate for ${APP_DOMAIN}..."
compose run --rm --no-deps --entrypoint certbot certbot "${CERTBOT_ARGS[@]}"

echo "==> Restarting nginx to switch to HTTPS mode..."
compose restart nginx

# Wait briefly for nginx to reload into HTTPS mode and confirm port 443 is configured.
for _ in $(seq 1 15); do
  if compose exec -T nginx grep -q "listen 443 ssl" /etc/nginx/conf.d/default.conf 2>/dev/null; then
    break
  fi
  sleep 1
done

if ! compose exec -T nginx grep -q "listen 443 ssl" /etc/nginx/conf.d/default.conf 2>/dev/null; then
  echo "ERROR: nginx did not switch to HTTPS mode. Check logs with:" >&2
  echo "  docker compose -f docker-compose.prod.yml --env-file $ENV_FILE logs nginx" >&2
  exit 1
fi

echo "==> Starting certbot automatic renewal container..."
compose up -d --no-deps certbot

echo "OK: TLS certificate provisioned for ${APP_DOMAIN}, nginx is serving HTTPS, and certbot renewals are active."
