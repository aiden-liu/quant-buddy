#!/usr/bin/env bash
set -euo pipefail

USER_HOME="${HOME:-}"
if [ -z "${USER_HOME}" ]; then
  USER_HOME="$(getent passwd "$(id -u)" | cut -d: -f6)"
fi

if [ -z "${USER_HOME}" ]; then
  echo "Unable to determine user home directory" >&2
  exit 1
fi

CLAUDE_STATE_FILE="${USER_HOME}/.claude.json"
export CLAUDE_STATE_FILE

node - <<'NODE'
const fs = require('fs');
const path = process.env.CLAUDE_STATE_FILE;

let data = {};
try {
  if (fs.existsSync(path)) {
    data = JSON.parse(fs.readFileSync(path, 'utf8') || '{}');
  }
} catch {
  data = {};
}

data.hasCompletedOnboarding = true;
fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
NODE
