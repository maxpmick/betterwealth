#!/usr/bin/env bash
set -euo pipefail

mode="${1:---all}"
api_url="${BETTERWEALTH_API_HEALTH_URL:-http://127.0.0.1:3001/health}"
web_url="${BETTERWEALTH_WEB_HEALTH_URL:-http://127.0.0.1:4173/}"
timeout_seconds="${HEALTHCHECK_TIMEOUT_SECONDS:-5}"

require_curl() {
  if ! command -v curl >/dev/null 2>&1; then
    echo "BetterWealth health check requires curl." >&2
    exit 127
  fi
}

check_api() {
  local body
  body="$(curl --fail --silent --show-error --max-time "$timeout_seconds" \
    --retry 3 --retry-connrefused --retry-delay 1 "$api_url")"
  if ! grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' <<<"$body" || \
    ! grep -Eq '"database"[[:space:]]*:[[:space:]]*"ready"' <<<"$body"; then
    echo "BetterWealth API health response did not report a ready database." >&2
    exit 1
  fi
  echo "BetterWealth API health: ready"
}

check_web() {
  curl --fail --silent --show-error --max-time "$timeout_seconds" \
    --retry 3 --retry-connrefused --retry-delay 1 --output /dev/null "$web_url"
  echo "BetterWealth web health: ready"
}

require_curl
case "$mode" in
  --all)
    check_api
    check_web
    ;;
  --api-only)
    check_api
    ;;
  --web-only)
    check_web
    ;;
  *)
    echo "Usage: $0 [--all|--api-only|--web-only]" >&2
    exit 64
    ;;
esac
