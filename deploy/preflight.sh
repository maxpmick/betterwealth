#!/usr/bin/env bash
set -euo pipefail

env_file="${1:-/etc/betterwealth.env}"
app_root="${BETTERWEALTH_ROOT:-/opt/betterwealth}"
service_user="${BETTERWEALTH_USER:-betterwealth}"
errors=0
warnings=0

pass() { echo "PASS  $1"; }
warn() { echo "WARN  $1" >&2; warnings=$((warnings + 1)); }
fail() { echo "FAIL  $1" >&2; errors=$((errors + 1)); }

value_for() {
  local key="$1"
  awk -v wanted="$key" '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    {
      line=$0
      sub(/^[[:space:]]*(export[[:space:]]+)?/, "", line)
      if (index(line, wanted "=") != 1) next
      sub("^" wanted "=[[:space:]]*", "", line)
      sub(/[[:space:]]+$/, "", line)
      if ((substr(line,1,1)=="\"" && substr(line,length(line),1)=="\"") ||
          (substr(line,1,1)=="\047" && substr(line,length(line),1)=="\047")) {
        line=substr(line,2,length(line)-2)
      }
      print line
      exit
    }
  ' "$env_file"
}

file_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

file_owner() {
  if stat -c '%U' "$1" >/dev/null 2>&1; then
    stat -c '%U' "$1"
  else
    stat -f '%Su' "$1"
  fi
}

if [[ ! -f "$env_file" ]]; then
  echo "FAIL  Environment file is missing: $env_file" >&2
  exit 1
fi

if [[ "$(file_mode "$env_file")" == "600" ]]; then
  pass "environment file mode is 0600"
else
  fail "environment file must have mode 0600"
fi

if [[ "$(file_owner "$env_file")" == "root" ]]; then
  pass "environment file is root-owned"
else
  warn "environment file should normally be owned by root"
fi

app_env="$(value_for APP_ENV)"
api_host="$(value_for API_HOST)"
api_port="$(value_for API_PORT)"
web_origin="$(value_for WEB_ORIGIN)"
database_url="$(value_for DATABASE_URL)"
encryption_key="$(value_for ENCRYPTION_KEY)"
cookie_secure="$(value_for COOKIE_SECURE)"
registration_mode="$(value_for REGISTRATION_MODE)"

[[ "$app_env" == "production" ]] && pass "APP_ENV is production" || fail "APP_ENV must be production"
[[ "$api_host" == "127.0.0.1" ]] && pass "API is bound to IPv4 loopback" || fail "API_HOST must be 127.0.0.1 for the supplied units"
[[ "$api_port" == "3001" ]] && pass "API port matches the web and Caddy examples" || fail "API_PORT must be 3001 unless both proxy configurations are changed"
[[ "$web_origin" =~ ^https://[^/]+$ ]] && pass "WEB_ORIGIN is an exact HTTPS origin" || fail "WEB_ORIGIN must be one exact HTTPS origin with no path or trailing slash"
[[ "$cookie_secure" == "true" ]] && pass "secure cookies are enabled" || fail "COOKIE_SECURE must be true"
[[ "$encryption_key" =~ ^[0-9a-fA-F]{64}$ ]] && pass "encryption key has the required format" || fail "ENCRYPTION_KEY must be exactly 64 hexadecimal characters"

case "$registration_mode" in
  closed|invite) pass "public registration is disabled" ;;
  open) warn "REGISTRATION_MODE=open allows anyone who can reach the site to register" ;;
  *) fail "REGISTRATION_MODE must be closed, invite, or open" ;;
esac

case "$database_url" in
  ./data/*|/opt/betterwealth/data/*) pass "database path is inside the writable data directory" ;;
  *) fail "DATABASE_URL must resolve inside /opt/betterwealth/data for the supplied sandbox" ;;
esac

if [[ -e "$app_root/.env.local" ]]; then
  fail "remove .env.local from the production checkout; systemd must be the only environment source"
else
  pass "production checkout has no .env.local override"
fi

for command_name in /usr/local/bin/bun curl; do
  if command -v "$command_name" >/dev/null 2>&1; then
    pass "found $command_name"
  else
    fail "missing required command: $command_name"
  fi
done

if [[ -f "$app_root/apps/web/dist/index.html" ]]; then
  pass "production web build exists"
else
  fail "production web build is missing; run bun run build"
fi

for directory in "$app_root/data" "$app_root/backups"; do
  if [[ ! -d "$directory" ]]; then
    fail "required directory is missing: $directory"
    continue
  fi
  mode="$(file_mode "$directory")"
  owner="$(file_owner "$directory")"
  [[ "$mode" == "700" ]] && pass "$(basename "$directory") directory mode is 0700" || fail "$(basename "$directory") directory must have mode 0700"
  [[ "$owner" == "$service_user" ]] && pass "$(basename "$directory") is owned by $service_user" || fail "$(basename "$directory") must be owned by $service_user"
done

if ((errors > 0)); then
  echo "Preflight failed with $errors error(s) and $warnings warning(s)." >&2
  exit 1
fi

echo "Preflight passed with $warnings warning(s)."
