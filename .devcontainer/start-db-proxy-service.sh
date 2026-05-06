#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_SCRIPT="${SCRIPT_DIR}/dbx-anthropic-proxy.js"
WORKSPACE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${WORKSPACE_DIR}/.env"
SUPERVISOR_LOG="/tmp/dbx-proxy-supervisor.log"
PROXY_LOG="/tmp/dbx-anthropic-proxy.log"

if [ "${1:-}" = "--supervise" ]; then
  if [ ! -f "${PROXY_SCRIPT}" ]; then
    echo "Proxy script not found: ${PROXY_SCRIPT}" >&2
    exit 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "node is not available in PATH" >&2
    exit 1
  fi

  cd "${WORKSPACE_DIR}"

  if [ -f "${ENV_FILE}" ]; then
    set -a
    # shellcheck disable=SC1090
    source "${ENV_FILE}"
    set +a
  fi

  while true; do
    if ! pgrep -f "[d]bx-anthropic-proxy.js" >/dev/null 2>&1; then
      nohup node "${PROXY_SCRIPT}" >> "${PROXY_LOG}" 2>&1 &
      sleep 1
    fi
    sleep 5
  done
fi

if pgrep -f "[s]tart-db-proxy-service.sh --supervise" >/dev/null 2>&1; then
  exit 0
fi

if [ ! -x "${SCRIPT_DIR}/start-db-proxy-service.sh" ]; then
  echo "Service script not executable: ${SCRIPT_DIR}/start-db-proxy-service.sh" >&2
  exit 1
fi

nohup "${SCRIPT_DIR}/start-db-proxy-service.sh" --supervise > "${SUPERVISOR_LOG}" 2>&1 &
