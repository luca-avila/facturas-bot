#!/usr/bin/env bash
set -euo pipefail

DOMAIN=""
HTTP_PORT="80"
HTTPS_PORT="443"
INSECURE=0
EMAIL=""
RESOLVE_IP=""

usage() {
  cat <<'EOF'
Usage: deploy/smoke.sh --domain <domain> [--http-port 80] [--https-port 443] [--insecure] [--email <email>] [--resolve-ip <ip>]

Read-only post-deploy smoke test. Never creates documents/uploads or triggers LLM calls.
When --email is given, reads the password from SMOKE_PASSWORD or the first line of stdin
(never prints secrets).

Options:
  --domain <domain>    Target hostname (required)
  --http-port <port>   HTTP port to check redirect (default: 80)
  --https-port <port>  HTTPS port to check app/API (default: 443)
  --insecure           Allow self-signed TLS certificates (local testing only)
  --email <email>      Verify login, cookie flags, authenticated reads, and logout
  --resolve-ip <ip>    Resolve <domain> to <ip> locally via curl --resolve
  -h, --help           Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --domain)
      [ "$#" -ge 2 ] || { echo "ERROR: --domain requires a value." >&2; exit 1; }
      DOMAIN="$2"
      shift 2
      ;;
    --http-port)
      [ "$#" -ge 2 ] || { echo "ERROR: --http-port requires a value." >&2; exit 1; }
      HTTP_PORT="$2"
      shift 2
      ;;
    --https-port)
      [ "$#" -ge 2 ] || { echo "ERROR: --https-port requires a value." >&2; exit 1; }
      HTTPS_PORT="$2"
      shift 2
      ;;
    --insecure)
      INSECURE=1
      shift
      ;;
    --email)
      [ "$#" -ge 2 ] || { echo "ERROR: --email requires a value." >&2; exit 1; }
      EMAIL="$2"
      shift 2
      ;;
    --resolve-ip)
      [ "$#" -ge 2 ] || { echo "ERROR: --resolve-ip requires a value." >&2; exit 1; }
      RESOLVE_IP="$2"
      shift 2
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

if [ -z "$DOMAIN" ]; then
  echo "ERROR: --domain is required." >&2
  usage >&2
  exit 1
fi

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

CURL_BASE=(curl --silent --show-error --connect-timeout 10 --max-time 20)
if [ "$INSECURE" -eq 1 ]; then
  CURL_BASE+=(--insecure)
fi
if [ -n "$RESOLVE_IP" ]; then
  CURL_BASE+=(
    --resolve "${DOMAIN}:${HTTP_PORT}:${RESOLVE_IP}"
    --resolve "${DOMAIN}:${HTTPS_PORT}:${RESOLVE_IP}"
  )
fi

HTTP_BASE="http://${DOMAIN}"
if [ "$HTTP_PORT" != "80" ]; then
  HTTP_BASE="http://${DOMAIN}:${HTTP_PORT}"
fi

HTTPS_BASE="https://${DOMAIN}"
if [ "$HTTPS_PORT" != "443" ]; then
  HTTPS_BASE="https://${DOMAIN}:${HTTPS_PORT}"
fi

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
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

assert_status() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  if [ "$actual" != "$expected" ]; then
    fail "${label}: expected HTTP ${expected}, got ${actual}"
  fi
}

assert_security_headers() {
  local headers_file="$1"
  local label="$2"
  local hsts cto xfo rp

  hsts="$(header_value "$headers_file" "Strict-Transport-Security" | head -n 1)"
  cto="$(header_value "$headers_file" "X-Content-Type-Options" | head -n 1)"
  xfo="$(header_value "$headers_file" "X-Frame-Options" | head -n 1)"
  rp="$(header_value "$headers_file" "Referrer-Policy" | head -n 1)"

  [ -n "$hsts" ] || fail "${label}: missing Strict-Transport-Security header"
  [ "$(printf '%s' "$cto" | tr '[:upper:]' '[:lower:]')" = "nosniff" ] || fail "${label}: expected X-Content-Type-Options: nosniff, got '${cto}'"
  [ "$(printf '%s' "$xfo" | tr '[:upper:]' '[:lower:]')" = "deny" ] || fail "${label}: expected X-Frame-Options: DENY, got '${xfo}'"
  [ -n "$rp" ] || fail "${label}: missing Referrer-Policy header"
}

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

# 1. HTTP -> HTTPS 301 redirect (normal Host and forged Host header)
H_FILE="${TMPDIR}/headers"
B_FILE="${TMPDIR}/body"

STATUS="$("${CURL_BASE[@]}" -D "$H_FILE" -o "$B_FILE" -w '%{http_code}' "${HTTP_BASE}/a-resolver?smoke=1")"
assert_status "$STATUS" "301" "HTTP redirect"
LOC="$(header_value "$H_FILE" "Location" | head -n 1)"
EXPECTED_LOC="https://${DOMAIN}/a-resolver?smoke=1"
[ "$LOC" = "$EXPECTED_LOC" ] || fail "HTTP redirect Location expected '${EXPECTED_LOC}', got '${LOC}'"
pass "HTTP -> HTTPS 301 redirect preserves path/query"

STATUS="$("${CURL_BASE[@]}" -H "Host: evil.example.invalid" -D "$H_FILE" -o "$B_FILE" -w '%{http_code}' "${HTTP_BASE}/a-resolver?smoke=1")"
assert_status "$STATUS" "301" "HTTP redirect with forged Host"
LOC="$(header_value "$H_FILE" "Location" | head -n 1)"
[ "$LOC" = "$EXPECTED_LOC" ] || fail "HTTP redirect with forged Host expected '${EXPECTED_LOC}', got '${LOC}'"
pass "HTTP -> HTTPS redirect ignores forged Host header"

# 2. HTTPS root SPA + headers + Cache-Control
STATUS="$("${CURL_BASE[@]}" -D "$H_FILE" -o "$B_FILE" -w '%{http_code}' "${HTTPS_BASE}/")"
assert_status "$STATUS" "200" "HTTPS GET /"
CT="$(header_value "$H_FILE" "Content-Type" | head -n 1)"
printf '%s' "$CT" | grep -qi "text/html" || fail "GET / expected text/html, got '${CT}'"
CC="$(header_value "$H_FILE" "Cache-Control" | head -n 1)"
printf '%s' "$CC" | grep -qi "no-cache" || fail "GET / expected Cache-Control: no-cache, got '${CC}'"
assert_security_headers "$H_FILE" "GET /"
cp "$B_FILE" "${TMPDIR}/index.html"
pass "HTTPS GET / returns 200 text/html with security headers and Cache-Control: no-cache"

# 3. HTTPS SPA deep link
STATUS="$("${CURL_BASE[@]}" -D "$H_FILE" -o "$B_FILE" -w '%{http_code}' "${HTTPS_BASE}/a-resolver")"
assert_status "$STATUS" "200" "HTTPS GET /a-resolver"
CT="$(header_value "$H_FILE" "Content-Type" | head -n 1)"
printf '%s' "$CT" | grep -qi "text/html" || fail "GET /a-resolver expected text/html, got '${CT}'"
CC="$(header_value "$H_FILE" "Cache-Control" | head -n 1)"
printf '%s' "$CC" | grep -qi "no-cache" || fail "GET /a-resolver expected Cache-Control: no-cache, got '${CC}'"
assert_security_headers "$H_FILE" "GET /a-resolver"
pass "HTTPS SPA deep link /a-resolver returns 200 text/html with security headers"

# 4. Built /assets/* immutable caching
ASSET_PATH="$(grep -oE '/assets/[^"'\'' >]+' "${TMPDIR}/index.html" | head -n 1 || true)"
[ -n "$ASSET_PATH" ] || fail "Could not find a /assets/* reference in index.html"
STATUS="$("${CURL_BASE[@]}" -D "$H_FILE" -o "$B_FILE" -w '%{http_code}' "${HTTPS_BASE}${ASSET_PATH}")"
assert_status "$STATUS" "200" "HTTPS GET ${ASSET_PATH}"
CC="$(header_value "$H_FILE" "Cache-Control" | head -n 1)"
printf '%s' "$CC" | grep -qi "public" || fail "GET ${ASSET_PATH} expected public in Cache-Control, got '${CC}'"
printf '%s' "$CC" | grep -qi "immutable" || fail "GET ${ASSET_PATH} expected immutable in Cache-Control, got '${CC}'"
assert_security_headers "$H_FILE" "GET ${ASSET_PATH}"
pass "HTTPS GET ${ASSET_PATH} returns 200 with Cache-Control: public, immutable and security headers"

# 5. Unauthenticated API protection and /uploads/ isolation
for endpoint in "/api/auth/me" "/api/suppliers" "/api/images/00000000-0000-0000-0000-000000000000"; do
  STATUS="$("${CURL_BASE[@]}" -D "$H_FILE" -o "$B_FILE" -w '%{http_code}' "${HTTPS_BASE}${endpoint}")"
  assert_status "$STATUS" "401" "Unauthenticated GET ${endpoint}"
done
pass "Unauthenticated /api/auth/me, /api/suppliers, and /api/images/:id return 401"

STATUS="$("${CURL_BASE[@]}" -D "$H_FILE" -o "$B_FILE" -w '%{http_code}' "${HTTPS_BASE}/uploads/does-not-exist.jpg")"
assert_status "$STATUS" "404" "GET /uploads/does-not-exist.jpg"
pass "GET /uploads/* returns 404"

# 6. Optional authenticated read-only flow
if [ -n "$EMAIL" ]; then
  if [ -n "${SMOKE_PASSWORD:-}" ]; then
    PASSWORD="$SMOKE_PASSWORD"
  else
    if ! IFS= read -r PASSWORD; then
      fail "No password provided via SMOKE_PASSWORD or stdin"
    fi
  fi
  [ -n "$PASSWORD" ] || fail "Password is empty"

  COOKIE_JAR="${TMPDIR}/cookies.txt"
  LOGIN_PAYLOAD="$(printf '{"email":"%s","password":"%s"}' "$(json_escape "$EMAIL")" "$(json_escape "$PASSWORD")")"
  unset PASSWORD

  STATUS="$("${CURL_BASE[@]}" \
    -X POST \
    -H "Content-Type: application/json" \
    --data-binary "$LOGIN_PAYLOAD" \
    -c "$COOKIE_JAR" \
    -D "$H_FILE" \
    -o "$B_FILE" \
    -w '%{http_code}' \
    "${HTTPS_BASE}/api/auth/login")"
  unset LOGIN_PAYLOAD
  assert_status "$STATUS" "200" "POST /api/auth/login"

  SET_COOKIE="$(header_value "$H_FILE" "Set-Cookie" | grep -i '^session=' | head -n 1 || true)"
  [ -n "$SET_COOKIE" ] || fail "POST /api/auth/login did not set session cookie"
  printf '%s' "$SET_COOKIE" | grep -qi "httponly" || fail "session cookie missing HttpOnly"
  printf '%s' "$SET_COOKIE" | grep -qi "secure" || fail "session cookie missing Secure"
  printf '%s' "$SET_COOKIE" | grep -qi "samesite=strict" || fail "session cookie missing SameSite=Strict"
  printf '%s' "$SET_COOKIE" | grep -qi "path=/api" || fail "session cookie missing Path=/api"
  pass "POST /api/auth/login returns 200 with Secure; HttpOnly; SameSite=Strict; Path=/api cookie"

  STATUS="$("${CURL_BASE[@]}" -b "$COOKIE_JAR" -D "$H_FILE" -o "$B_FILE" -w '%{http_code}' "${HTTPS_BASE}/api/auth/me")"
  assert_status "$STATUS" "200" "Authenticated GET /api/auth/me"

  STATUS="$("${CURL_BASE[@]}" -b "$COOKIE_JAR" -D "$H_FILE" -o "$B_FILE" -w '%{http_code}' "${HTTPS_BASE}/api/suppliers")"
  assert_status "$STATUS" "200" "Authenticated GET /api/suppliers"
  pass "Authenticated GET /api/auth/me and /api/suppliers return 200"

  STATUS="$("${CURL_BASE[@]}" -X POST -b "$COOKIE_JAR" -c "$COOKIE_JAR" -D "$H_FILE" -o "$B_FILE" -w '%{http_code}' "${HTTPS_BASE}/api/auth/logout")"
  assert_status "$STATUS" "204" "POST /api/auth/logout"

  STATUS="$("${CURL_BASE[@]}" -b "$COOKIE_JAR" -D "$H_FILE" -o "$B_FILE" -w '%{http_code}' "${HTTPS_BASE}/api/auth/me")"
  assert_status "$STATUS" "401" "GET /api/auth/me after logout"
  pass "POST /api/auth/logout returns 204 and clears session"
fi

echo "ALL SMOKE CHECKS PASSED for ${DOMAIN}."
