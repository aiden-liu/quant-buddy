#!/usr/bin/env bash
# Bootstraps workspace env and proxy for every new VS Code terminal.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SERVICE_SCRIPT="${WORKSPACE_DIR}/.devcontainer/start-db-proxy-service.sh"
ENV_FILE="${WORKSPACE_DIR}/.env"

if [ -f "${ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

pkill -f "[s]tart-db-proxy-service.sh --supervise" >/dev/null 2>&1 || true
pkill -f "[d]bx-anthropic-proxy.js" >/dev/null 2>&1 || true

if [ -x "${SERVICE_SCRIPT}" ]; then
  "${SERVICE_SCRIPT}" || true
fi
