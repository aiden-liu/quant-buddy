# Claude Code Dev Container (Databricks Proxy)

A pre-configured VS Code Dev Container that runs [Claude Code](https://docs.anthropic.com/en/docs/claude-code) backed by **Databricks-hosted Claude models** via a local API translation proxy. This enables teams to use Claude Code within enterprise Databricks Model Serving infrastructure instead of calling the Anthropic API directly.

## How It Works

```
Claude Code CLI
      |
      | Anthropic Messages API format
      v
Local Proxy (http://127.0.0.1:8787)
      |
      | OpenAI-compatible format
      v
Databricks Model Serving
(Claude Sonnet 4.6 / Opus 4.6)
```

The core of this project is a lightweight Node.js reverse proxy (`dbx-anthropic-proxy.js`) that:

- Receives requests from Claude Code in **Anthropic Messages API** format
- Translates them to the **OpenAI-compatible format** used by Databricks Model Serving
- Routes to the correct Databricks endpoint based on model name (Sonnet or Opus)
- Translates responses back to Anthropic format for Claude Code to consume

## Prerequisites

- [VS Code](https://code.visualstudio.com/) with the [Dev Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) extension
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or a compatible container runtime)
- A Databricks workspace with Claude models deployed via [Model Serving](https://docs.databricks.com/en/machine-learning/model-serving/index.html)
- A Databricks personal access token (PAT)

## Getting Started

### 1. Configure environment variables

```bash
cp .env.sample .env
```

Edit `.env` with your values:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_AUTH_TOKEN` | Your Databricks personal access token (PAT) |
| `ANTHROPIC_BASE_URL` | Proxy address (default: `http://127.0.0.1:8787`) |
| `API_TIMEOUT_MS` | Request timeout in milliseconds (default: `3000000`) |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | Set to `1` to prevent Claude Code from calling Anthropic directly |
| `DATABRICKS_WORKSPACE_URL` | Your Databricks workspace URL (e.g. `https://adb-123.4.azuredatabricks.net`) |
| `DATABRICKS_SERVED_MODELS` | Comma-separated model endpoint names (e.g. `databricks-claude-sonnet-4-6,databricks-claude-opus-4-6`) |

### 2. Open in Dev Container

Open this folder in VS Code and select **"Reopen in Container"** (or use the Command Palette: `Dev Containers: Reopen in Container`).

The container will automatically:
- Install Node.js 24 (LTS) via NVM
- Install `@anthropic-ai/claude-code` globally
- Skip the Claude Code onboarding wizard
- Start the Databricks proxy on `http://127.0.0.1:8787`

### 3. Start using Claude Code

```bash
claude            # Launch Claude Code (routes through Databricks proxy)
claude --version  # Verify installation
```

## Project Structure

```
.devcontainer/
  devcontainer.json             # Dev Container configuration
  dbx-anthropic-proxy.js        # Databricks <-> Anthropic API translation proxy
  start-db-proxy-service.sh     # Proxy supervisor/launcher (auto-restart)
  init-claude-onboarding.sh     # Skips Claude Code first-run wizard
.vscode/
  settings.json                 # Terminal auto-configuration
  terminal-bootstrap.sh         # Loads .env and restarts proxy on new terminals
.claude/
  agents/                       # Custom Claude sub-agent definitions
.env.sample                     # Environment variable template
.env                            # Your local config (gitignored)
```

## Proxy API Reference

The proxy runs on `http://127.0.0.1:8787` and exposes two endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check -- returns proxy status and configured Databricks endpoints |
| `POST` | `/v1/messages` | Translates Anthropic Messages API requests to Databricks and back |

### Health check

```bash
curl http://127.0.0.1:8787/health
```

### Model routing

- Requests for models containing **"opus"** in the name route to the Opus endpoint
- All other requests (Sonnet, Haiku, etc.) route to the Sonnet endpoint (default)

### Debug mode

Set `DBX_PROXY_TOOL_DEBUG=1` in your `.env` to enable verbose tool-call logging from the proxy.

## Included Tools

The Dev Container comes pre-configured with:

- **Python 3.11** (base image)
- **Node.js 24** (LTS, via NVM)
- **Azure CLI**
- **Terraform**, **tflint**, **terragrunt**
- **Git** with LF line ending configuration
- VS Code extensions for Python, Jupyter, Terraform, YAML, JSON, Jinja2, Draw.io, and Azure

## Troubleshooting

### Proxy not running

```bash
# Check if the proxy is alive
curl http://127.0.0.1:8787/health

# View proxy logs
tail -f /tmp/dbx-anthropic-proxy.log

# View supervisor logs
tail -f /tmp/dbx-proxy-supervisor.log

# Manually restart the proxy
bash .devcontainer/start-db-proxy-service.sh
```

### Claude Code can't connect

- Verify `.env` is properly configured (especially `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`)
- Open a new terminal (the bootstrap script re-sources `.env` and restarts the proxy)
- Check that your Databricks PAT is valid and has access to the model serving endpoints

### Streaming not supported

The proxy operates in **non-streaming mode only**. Claude Code will automatically fall back to non-streaming requests. Streaming requests return a 404 response.

## Notes

- The `.env` file is gitignored to prevent accidentally committing secrets
- The proxy uses only built-in Node.js modules (`http`, `url`) -- no npm dependencies required
- Each new VS Code terminal automatically sources `.env` and ensures the proxy is running
