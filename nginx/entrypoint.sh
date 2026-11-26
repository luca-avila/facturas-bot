#!/bin/sh
set -eu

if [ -z "${APP_DOMAIN:-}" ]; then
  echo "ERROR: APP_DOMAIN must be set." >&2
  exit 1
fi

case "$APP_DOMAIN" in
  *..*|.*|*.|-*|*-|*[^A-Za-z0-9.-]*)
    echo "ERROR: APP_DOMAIN contains invalid characters: $APP_DOMAIN" >&2
    exit 1
    ;;
esac

CERT_DIR="/etc/letsencrypt/live/${APP_DOMAIN}"
FULLCHAIN="${CERT_DIR}/fullchain.pem"
PRIVKEY="${CERT_DIR}/privkey.pem"

if [ -r "$FULLCHAIN" ] && [ -r "$PRIVKEY" ]; then
  TEMPLATE="/etc/nginx/templates/https.conf.template"
  MODE="https"
else
  TEMPLATE="/etc/nginx/templates/http-only.conf.template"
  MODE="http-only"
fi

export APP_DOMAIN
envsubst '${APP_DOMAIN}' < "$TEMPLATE" > /etc/nginx/conf.d/default.conf

echo "nginx: starting in ${MODE} mode for ${APP_DOMAIN}"
nginx -t

RELOAD_PID=""
NGINX_PID=""

cleanup() {
  if [ -n "$RELOAD_PID" ]; then
    kill "$RELOAD_PID" 2>/dev/null || true
  fi
  if [ -n "$NGINX_PID" ]; then
    kill -QUIT "$NGINX_PID" 2>/dev/null || true
    wait "$NGINX_PID" 2>/dev/null || true
  fi
  exit 0
}

trap cleanup TERM INT QUIT

if [ "$MODE" = "https" ]; then
  (
    while true; do
      sleep 21600 &
      SLEEP_PID=$!
      trap 'kill "$SLEEP_PID" 2>/dev/null || true; exit 0' TERM INT QUIT
      wait "$SLEEP_PID" || exit 0
      if nginx -t >/dev/null 2>&1; then
        nginx -s reload || true
      fi
    done
  ) &
  RELOAD_PID=$!
fi

nginx -g 'daemon off;' &
NGINX_PID=$!
wait "$NGINX_PID"
STATUS=$?

if [ -n "$RELOAD_PID" ]; then
  kill "$RELOAD_PID" 2>/dev/null || true
fi

exit "$STATUS"
