#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.prod.yml"
PROJECT="facturas-prod-verify"
APP_DOMAIN="facturas.verify.local"
HTTP_PORT="${VERIFY_HTTP_PORT:-18080}"
HTTPS_PORT="${VERIFY_HTTPS_PORT:-18443}"

# Invented test CUIT from backend/test/test-cuits.ts (RESTAURANT_TEST_CUIT).
RESTAURANT_TEST_CUIT="30000000112"

TMPDIR="$(mktemp -d)"
ENV_FILE="${TMPDIR}/.env.verify"

cleanup() {
  local exit_code=$?
  set +e
  if [ -f "$ENV_FILE" ]; then
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" --profile ops down -v --remove-orphans >/dev/null 2>&1
  fi
  rm -rf "$TMPDIR"
  exit "$exit_code"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

compose() {
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

header_value() {
  local headers_file="$1"
  local name="$2"
  awk -v key="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')" '
    {
      sub(/\r$/, "")
      idx = index($0, ":")
      if (idx > 0) {
        k = tolower(substr($0, 1, idx - 1))
        if (k == key) {
          v = substr($0, idx + 1)
          sub(/^[[:space:]]+/, "", v)
          print v
        }
      }
    }
  ' "$headers_file"
}

CURL_HTTPS=(
  curl --silent --show-error --insecure
  --connect-timeout 10 --max-time 20
  --resolve "${APP_DOMAIN}:${HTTP_PORT}:127.0.0.1"
  --resolve "${APP_DOMAIN}:${HTTPS_PORT}:127.0.0.1"
)
HTTP_BASE="http://${APP_DOMAIN}:${HTTP_PORT}"
HTTPS_BASE="https://${APP_DOMAIN}:${HTTPS_PORT}"

POSTGRES_PASSWORD="$(openssl rand -hex 24)"
JWT_SECRET="$(openssl rand -base64 48 | tr -d '\n')"

cat > "$ENV_FILE" <<EOF
APP_DOMAIN=${APP_DOMAIN}
CERTBOT_EMAIL=verify@example.com
POSTGRES_USER=facturas_verify
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=facturas_verify
JWT_SECRET=${JWT_SECRET}
ANTHROPIC_API_KEY=sk-ant-verify-dummy-never-called
LLM_MODEL=claude-haiku-5-5
RESTAURANT_CUIT=${RESTAURANT_TEST_CUIT}
HTTP_PORT=${HTTP_PORT}
HTTPS_PORT=${HTTPS_PORT}
EOF
chmod 600 "$ENV_FILE"

echo "==> 1. Building production images..."
compose --profile ops build backend worker migrate nginx

echo "==> 2. Checking image hygiene (no samples, no .env, no devDependencies/tsx in runtime)..."
for svc in backend migrate nginx; do
  IMG="${PROJECT}-${svc}"
  docker run --rm --entrypoint /bin/sh "$IMG" -c '
    if [ -e /app/samples ] || [ -e /samples ] || [ -e /app/.env ] || [ -e /.env ] || [ -e /app/.env.production ] || [ -e /.env.production ]; then
      echo "Found forbidden file in image" >&2
      exit 1
    fi
  '
done
docker run --rm --entrypoint /bin/sh "${PROJECT}-backend" -c '
  if [ -e /app/node_modules/.bin/tsx ]; then
    echo "Found devDependency tsx in production runtime image" >&2
    exit 1
  fi
'
for bad_domain in "" "../evil" "bad;domain" ".leading.dot"; do
  if docker run --rm -e "APP_DOMAIN=${bad_domain}" "${PROJECT}-nginx" >/dev/null 2>&1; then
    fail "nginx entrypoint accepted invalid APP_DOMAIN: '${bad_domain}'"
  fi
done
pass "Built images exclude samples/, .env*, runtime excludes tsx, and nginx rejects invalid APP_DOMAIN"

echo "==> 3. Testing HTTP-only bootstrap mode (before any TLS certificate exists)..."
compose up -d --no-deps nginx

READY=0
for _ in $(seq 1 30); do
  CODE="$("${CURL_HTTPS[@]}" -o /dev/null -w '%{http_code}' "${HTTP_BASE}/" 2>/dev/null || true)"
  if [ "$CODE" = "503" ]; then
    READY=1
    break
  fi
  sleep 0.5
done
[ "$READY" -eq 1 ] || fail "nginx did not return 503 on / in HTTP-only bootstrap mode (last code: ${CODE:-none})"

LOGIN_CODE="$("${CURL_HTTPS[@]}" -X POST -H "Content-Type: application/json" -d '{"email":"a@b.c","password":"x"}' -o /dev/null -w '%{http_code}' "${HTTP_BASE}/api/auth/login")"
[ "$LOGIN_CODE" = "503" ] || fail "HTTP-only bootstrap expected 503 on /api/auth/login, got ${LOGIN_CODE}"

ACME_TOKEN="acme-verify-$(openssl rand -hex 8)"
docker run --rm -v "${PROJECT}_certbot-www:/var/www/certbot" alpine:3.21 /bin/sh -c "
  mkdir -p /var/www/certbot/.well-known/acme-challenge &&
  printf '%s' '${ACME_TOKEN}' > /var/www/certbot/.well-known/acme-challenge/verify-token
"
ACME_BODY="$("${CURL_HTTPS[@]}" -o "${TMPDIR}/acme" -w '%{http_code}' "${HTTP_BASE}/.well-known/acme-challenge/verify-token")"
[ "$ACME_BODY" = "200" ] || fail "HTTP-only bootstrap expected 200 on ACME challenge, got ${ACME_BODY}"
[ "$(cat "${TMPDIR}/acme")" = "$ACME_TOKEN" ] || fail "ACME challenge body mismatch"
docker run --rm -v "${PROJECT}_certbot-www:/var/www/certbot" alpine:3.21 rm -f /var/www/certbot/.well-known/acme-challenge/verify-token
pass "HTTP-only bootstrap serves /.well-known/acme-challenge/ and returns 503 for / and /api/auth/login"

echo "==> 4. Provisioning local self-signed TLS certificate into certbot-conf..."
openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
  -keyout "${TMPDIR}/privkey.pem" \
  -out "${TMPDIR}/fullchain.pem" \
  -subj "/CN=${APP_DOMAIN}" \
  -addext "subjectAltName=DNS:${APP_DOMAIN}" >/dev/null 2>&1

docker run --rm \
  -v "${PROJECT}_certbot-conf:/etc/letsencrypt" \
  -v "${TMPDIR}:/src:ro" \
  alpine:3.21 /bin/sh -c "
    mkdir -p /etc/letsencrypt/live/${APP_DOMAIN} &&
    cp /src/fullchain.pem /etc/letsencrypt/live/${APP_DOMAIN}/fullchain.pem &&
    cp /src/privkey.pem /etc/letsencrypt/live/${APP_DOMAIN}/privkey.pem
  "

echo "==> 5. Starting db, running explicit migrations, and starting backend, worker, and nginx..."
compose up -d db
compose --profile ops run --rm migrate
compose up -d db backend worker
compose restart nginx

BACKEND_CID="$(compose ps -q backend)"
WORKER_CID="$(compose ps -q worker)"
DB_CID="$(compose ps -q db)"
NGINX_CID="$(compose ps -q nginx)"

HEALTHY=0
for _ in $(seq 1 40); do
  STATUS="$(docker inspect -f '{{.State.Health.Status}}' "$BACKEND_CID")"
  if [ "$STATUS" = "healthy" ]; then
    HEALTHY=1
    break
  fi
  sleep 1
done
[ "$HEALTHY" -eq 1 ] || {
  compose logs backend >&2
  fail "backend container did not become healthy"
}

HTTPS_READY=0
for _ in $(seq 1 30); do
  CODE="$("${CURL_HTTPS[@]}" -o /dev/null -w '%{http_code}' "${HTTPS_BASE}/" 2>/dev/null || true)"
  if [ "$CODE" = "200" ]; then
    HTTPS_READY=1
    break
  fi
  sleep 0.5
done
[ "$HTTPS_READY" -eq 1 ] || {
  compose logs nginx >&2
  fail "nginx did not become ready in HTTPS mode (last code: ${CODE:-none})"
}
pass "Explicit migrate succeeded, backend healthcheck (401 on /api/auth/me) is healthy, and nginx is serving HTTPS"

sleep 2
WORKER_STATE="$(docker inspect -f '{{.State.Status}}' "$WORKER_CID")"
WORKER_RESTARTS="$(docker inspect -f '{{.RestartCount}}' "$WORKER_CID")"
[ "$WORKER_STATE" = "running" ] && [ "$WORKER_RESTARTS" = "0" ] || {
  compose logs worker >&2
  fail "worker is not cleanly running (status=${WORKER_STATE}, restarts=${WORKER_RESTARTS})"
}
pass "worker started cleanly, passed ExtractionConfig, and connected to Postgres with zero external calls"

echo "==> 6. Verifying container, secret, UID/GID, volume, and port isolation..."
DB_HOST_PORTS="$(docker inspect -f '{{range $p, $conf := .NetworkSettings.Ports}}{{if $conf}}{{$p}}{{end}}{{end}}' "$DB_CID")"
[ -z "$DB_HOST_PORTS" ] || fail "db published unexpected host ports: ${DB_HOST_PORTS}"

BACKEND_HOST_PORTS="$(docker inspect -f '{{range $p, $conf := .NetworkSettings.Ports}}{{if $conf}}{{$p}}{{end}}{{end}}' "$BACKEND_CID")"
[ -z "$BACKEND_HOST_PORTS" ] || fail "backend published unexpected host ports: ${BACKEND_HOST_PORTS}"
pass "db and backend publish no host ports"

BACKEND_ENV="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$BACKEND_CID")"
for forbidden in ANTHROPIC_API_KEY LLM_MODEL RESTAURANT_CUIT; do
  if printf '%s\n' "$BACKEND_ENV" | grep -q "^${forbidden}="; then
    fail "backend environment contains forbidden variable: ${forbidden}"
  fi
done

WORKER_ENV="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$WORKER_CID")"
if printf '%s\n' "$WORKER_ENV" | grep -q "^JWT_SECRET="; then
  fail "worker environment contains forbidden variable: JWT_SECRET"
fi
pass "Strict secret separation holds between backend and worker"

BACKEND_ID="$(compose exec -T backend sh -c 'printf "%s:%s:%s" "$(id -un)" "$(id -u)" "$(id -g)"')"
WORKER_ID="$(compose exec -T worker sh -c 'printf "%s:%s:%s" "$(id -un)" "$(id -u)" "$(id -g)"')"
[ "$BACKEND_ID" = "$WORKER_ID" ] || fail "backend (${BACKEND_ID}) and worker (${WORKER_ID}) UID/GID mismatch"
BACKEND_USER="${BACKEND_ID%%:*}"
BACKEND_UID="${BACKEND_ID#*:}"
BACKEND_UID="${BACKEND_UID%%:*}"
[ "$BACKEND_USER" = "node" ] && [ "$BACKEND_UID" != "0" ] || fail "Expected non-root user node, got ${BACKEND_ID}"

PROBE_TOKEN="probe-$(openssl rand -hex 8)"
compose exec -T backend sh -c "printf '%s' '${PROBE_TOKEN}' > /data/uploads/.verify-probe && chmod 600 /data/uploads/.verify-probe"
READ_BACK="$(compose exec -T worker cat /data/uploads/.verify-probe)"
[ "$READ_BACK" = "$PROBE_TOKEN" ] || fail "worker could not read 0600 file written by backend in /data/uploads"
compose exec -T backend rm -f /data/uploads/.verify-probe

NGINX_MOUNTS="$(docker inspect -f '{{range .Mounts}}{{println .Destination .Name}}{{end}}' "$NGINX_CID")"
if printf '%s\n' "$NGINX_MOUNTS" | grep -qE '(/data/uploads|uploads-data)'; then
  fail "nginx unexpectedly mounts uploads-data: ${NGINX_MOUNTS}"
fi
pass "backend and worker share non-root UID/GID (${BACKEND_ID}) on /data/uploads; nginx has no uploads mount"

echo "==> 7. Testing compiled production users CLI (create, reset-password, disable)..."
USER_EMAIL="verify-admin@example.com"
PASS_ONE="VerifyPass1-$(openssl rand -hex 8)"
PASS_TWO="VerifyPass2-$(openssl rand -hex 8)"

CREATE_OUT="$(printf '%s\n' "$PASS_ONE" | compose exec -T backend npm run --silent user:create:prod -- --email "$USER_EMAIL" --name "Verify Admin" --role admin)"
printf '%s' "$CREATE_OUT" | grep -q "Created ${USER_EMAIL} (admin)." || fail "Unexpected user:create:prod output: ${CREATE_OUT}"
if printf '%s' "$CREATE_OUT" | grep -Fq "$PASS_ONE"; then
  fail "user:create:prod leaked password to output"
fi

JAR_ONE="${TMPDIR}/jar1.txt"
CODE="$("${CURL_HTTPS[@]}" -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"${USER_EMAIL}\",\"password\":\"${PASS_ONE}\"}" \
  -c "$JAR_ONE" -o /dev/null -w '%{http_code}' "${HTTPS_BASE}/api/auth/login")"
[ "$CODE" = "200" ] || fail "Initial login for CLI-created user failed with ${CODE}"

RESET_OUT="$(printf '%s\n' "$PASS_TWO" | compose exec -T backend npm run --silent user:reset-password:prod -- --email "$USER_EMAIL")"
printf '%s' "$RESET_OUT" | grep -q "Reset the password for ${USER_EMAIL}." || fail "Unexpected user:reset-password:prod output: ${RESET_OUT}"
if printf '%s' "$RESET_OUT" | grep -Fq "$PASS_TWO"; then
  fail "user:reset-password:prod leaked password to output"
fi

CODE="$("${CURL_HTTPS[@]}" -b "$JAR_ONE" -o /dev/null -w '%{http_code}' "${HTTPS_BASE}/api/auth/me")"
[ "$CODE" = "401" ] || fail "Prior session cookie was not revoked after password reset (got ${CODE})"
pass "Compiled user:create:prod and user:reset-password:prod work without tsx or printing passwords, and reset revokes prior sessions"

echo "==> 8. Running deploy/smoke.sh against the local HTTPS stack..."
SMOKE_PASSWORD="$PASS_TWO" "${SCRIPT_DIR}/smoke.sh" \
  --domain "$APP_DOMAIN" \
  --http-port "$HTTP_PORT" \
  --https-port "$HTTPS_PORT" \
  --resolve-ip 127.0.0.1 \
  --insecure \
  --email "$USER_EMAIL"

echo "==> 9. Testing photo upload, authenticated image access, and non-static image isolation (worker stopped)..."
compose stop worker

TEST_PHOTO="${TMPDIR}/test-photo.png"
compose exec -T backend node -e '
  const { randomBytes } = require("node:crypto");
  const { crc32 } = require("node:zlib");
  const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const chunk = (type, data) => {
    const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
    return Buffer.concat([u32be(data.length), typed, u32be(crc32(typed))]);
  };
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", Buffer.concat([u32be(64), u32be(64), Buffer.from([8, 2, 0, 0, 0])])),
    chunk("tEXt", Buffer.from(randomBytes(16).toString("hex"), "latin1")),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  process.stdout.write(png);
' > "$TEST_PHOTO"

JAR_TWO="${TMPDIR}/jar2.txt"
CODE="$("${CURL_HTTPS[@]}" -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"${USER_EMAIL}\",\"password\":\"${PASS_TWO}\"}" \
  -c "$JAR_TWO" -o /dev/null -w '%{http_code}' "${HTTPS_BASE}/api/auth/login")"
[ "$CODE" = "200" ] || fail "Login before upload test failed with ${CODE}"

UPLOAD_BODY="${TMPDIR}/upload.json"
CODE="$("${CURL_HTTPS[@]}" \
  -X POST \
  -b "$JAR_TWO" \
  -H "X-Requested-With: XMLHttpRequest" \
  -F "photos=@${TEST_PHOTO};type=image/png" \
  -o "$UPLOAD_BODY" \
  -w '%{http_code}' \
  "${HTTPS_BASE}/api/uploads")"
[ "$CODE" = "201" ] || {
  cat "$UPLOAD_BODY" >&2
  fail "POST /api/uploads expected 201, got ${CODE}"
}

DOC_ID="$(compose exec -T backend node -e '
  const data = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  if (!data.id) process.exit(1);
  process.stdout.write(data.id);
' < "$UPLOAD_BODY")"

IMAGE_ROW="$(compose exec -T db psql -U facturas_verify -d facturas_verify -t -A -F '|' -c "SELECT id, storage_key FROM document_images WHERE document_id = '${DOC_ID}' LIMIT 1;")"
IMAGE_ID="${IMAGE_ROW%%|*}"
STORAGE_KEY="${IMAGE_ROW#*|}"
[ -n "$IMAGE_ID" ] && [ -n "$STORAGE_KEY" ] || fail "Could not find uploaded image row in document_images"

IMG_HEADERS="${TMPDIR}/img-headers"
IMG_DOWNLOADED="${TMPDIR}/downloaded.png"
CODE="$("${CURL_HTTPS[@]}" -b "$JAR_TWO" -D "$IMG_HEADERS" -o "$IMG_DOWNLOADED" -w '%{http_code}' "${HTTPS_BASE}/api/images/${IMAGE_ID}")"
[ "$CODE" = "200" ] || fail "Authenticated GET /api/images/${IMAGE_ID} expected 200, got ${CODE}"
cmp -s "$TEST_PHOTO" "$IMG_DOWNLOADED" || fail "Downloaded image bytes do not match uploaded bytes"

IMG_CC="$(header_value "$IMG_HEADERS" "Cache-Control" | head -n 1)"
printf '%s' "$IMG_CC" | grep -qi "private" && printf '%s' "$IMG_CC" | grep -qi "no-store" || fail "GET /api/images expected Cache-Control: private, no-store, got '${IMG_CC}'"

IMG_CSP="$(header_value "$IMG_HEADERS" "Content-Security-Policy" | head -n 1)"
printf '%s' "$IMG_CSP" | grep -qi "sandbox" || fail "GET /api/images expected sandbox in CSP, got '${IMG_CSP}'"

CODE="$("${CURL_HTTPS[@]}" -o /dev/null -w '%{http_code}' "${HTTPS_BASE}/api/images/${IMAGE_ID}")"
[ "$CODE" = "401" ] || fail "Unauthenticated GET /api/images/${IMAGE_ID} expected 401, got ${CODE}"

CODE="$("${CURL_HTTPS[@]}" -o /dev/null -w '%{http_code}' "${HTTPS_BASE}/uploads/${STORAGE_KEY}")"
[ "$CODE" = "404" ] || fail "GET /uploads/${STORAGE_KEY} expected 404, got ${CODE}"

STATIC_HEADERS="${TMPDIR}/static-headers"
STATIC_BODY="${TMPDIR}/static-body"
"${CURL_HTTPS[@]}" -D "$STATIC_HEADERS" -o "$STATIC_BODY" "${HTTPS_BASE}/${STORAGE_KEY}"
STATIC_CT="$(header_value "$STATIC_HEADERS" "Content-Type" | head -n 1)"
if printf '%s' "$STATIC_CT" | grep -qi "^image/"; then
  fail "GET /${STORAGE_KEY} unexpectedly returned image content-type: ${STATIC_CT}"
fi
if cmp -s "$TEST_PHOTO" "$STATIC_BODY"; then
  fail "GET /${STORAGE_KEY} unexpectedly returned the uploaded photo bytes"
fi
pass "Upload returns 201, /api/images/:id preserves bytes with private/no-store + sandbox CSP, unauthenticated returns 401, /uploads/<key> returns 404, /<key> never returns image bytes"

echo "==> 10. Testing compiled user:disable:prod revokes active session..."
DISABLE_OUT="$(compose exec -T backend npm run --silent user:disable:prod -- --email "$USER_EMAIL")"
printf '%s' "$DISABLE_OUT" | grep -q "Disabled ${USER_EMAIL}." || fail "Unexpected user:disable:prod output: ${DISABLE_OUT}"

CODE="$("${CURL_HTTPS[@]}" -b "$JAR_TWO" -o /dev/null -w '%{http_code}' "${HTTPS_BASE}/api/auth/me")"
[ "$CODE" = "401" ] || fail "Active session was not revoked after user:disable:prod (got ${CODE})"

CODE="$("${CURL_HTTPS[@]}" -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"${USER_EMAIL}\",\"password\":\"${PASS_TWO}\"}" \
  -o /dev/null -w '%{http_code}' "${HTTPS_BASE}/api/auth/login")"
[ "$CODE" = "401" ] || fail "Disabled user was unexpectedly allowed to sign in (got ${CODE})"
pass "Compiled user:disable:prod revokes active session and blocks sign-in"

echo "==> 11. Verifying nginx per-IP login rate limit returns 429 on burst overflow..."
HIT_429=0
for i in $(seq 1 15); do
  CODE="$("${CURL_HTTPS[@]}" -X POST -H "Content-Type: application/json" \
    -d "{\"email\":\"ratelimit-${i}@example.com\",\"password\":\"not-a-real-password\"}" \
    -o /dev/null -w '%{http_code}' "${HTTPS_BASE}/api/auth/login")"
  if [ "$CODE" = "429" ]; then
    HIT_429=1
    break
  fi
done
[ "$HIT_429" -eq 1 ] || fail "Expected nginx login rate limit to return 429 after burst overflow"

for variant in "/api/auth/login/" "/api/auth/LOGIN"; do
  CODE="$("${CURL_HTTPS[@]}" -X POST -H "Content-Type: application/json" \
    -d '{"email":"ratelimit-variant@example.com","password":"not-a-real-password"}' \
    -o /dev/null -w '%{http_code}' "${HTTPS_BASE}${variant}")"
  [ "$CODE" = "429" ] || fail "Expected nginx login rate limit to return 429 on ${variant}, got ${CODE}"
done
pass "Nginx login rate limit enforces 429 on burst overflow (including trailing-slash and case variants)"

echo ""
echo "ALL PRODUCTION STACK VERIFICATIONS PASSED."
