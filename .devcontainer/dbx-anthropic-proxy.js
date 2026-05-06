#!/usr/bin/env node

const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8787);
const DBX_WORKSPACE_URL = (process.env.DATABRICKS_WORKSPACE_URL ||
  'https://adb-3240274369437577.17.azuredatabricks.net').replace(/\/+$/, '');
const DBX_SERVED_MODELS = (process.env.DATABRICKS_SERVED_MODELS ||
  'databricks-claude-sonnet-4-6,databricks-claude-opus-4-6')
  .replace(/^\[/, '')
  .replace(/\]$/, '')
  .split(',')
  .map((model) => model.trim().replace(/^['"]|['"]$/g, ''))
  .filter(Boolean);
const DBX_SONNET_MODEL = DBX_SERVED_MODELS[0] || 'databricks-claude-sonnet-4-6';
const DBX_OPUS_MODEL = DBX_SERVED_MODELS[1] || 'databricks-claude-opus-4-6';
const DBX_DEFAULT_ENDPOINT = process.env.DBX_ENDPOINT ||
  `${DBX_WORKSPACE_URL}/serving-endpoints/${DBX_SONNET_MODEL}/invocations`;
const DBX_SONNET_ENDPOINT = process.env.DBX_SONNET_ENDPOINT || DBX_DEFAULT_ENDPOINT;
const DBX_OPUS_ENDPOINT = process.env.DBX_OPUS_ENDPOINT ||
  `${DBX_WORKSPACE_URL}/serving-endpoints/${DBX_OPUS_MODEL}/invocations`;
const DEFAULT_MAX_TOKENS = Number(process.env.DEFAULT_MAX_TOKENS || 1024);
const TOOL_DEBUG_ENABLED = process.env.DBX_PROXY_TOOL_DEBUG === '1';

function normalizeModel(model) {
  if (typeof model !== 'string') {
    return '';
  }
  return model.trim().toLowerCase();
}

function resolveDbxEndpointForModel(model) {
  const normalized = normalizeModel(model);

  if (normalized.includes('opus')) {
    return { endpoint: DBX_OPUS_ENDPOINT, route: 'opus' };
  }

  // Default route covers sonnet and unknown models to keep behavior predictable.
  return { endpoint: DBX_SONNET_ENDPOINT, route: 'sonnet-default' };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.trim()) {
    return xApiKey.trim();
  }

  if (process.env.DBX_TOKEN && process.env.DBX_TOKEN.trim()) {
    return process.env.DBX_TOKEN.trim();
  }

  return null;
}

function extractText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object') {
          if (part.type === 'text' && typeof part.text === 'string') {
            return part.text;
          }
          if (typeof part.text === 'string') {
            return part.text;
          }
        }
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

function extractTextForToolResult(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (!part || typeof part !== 'object') {
          return '';
        }
        if (part.type === 'text' && typeof part.text === 'string') {
          return part.text;
        }
        if (typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('')
      .trim();
  }
  if (content && typeof content === 'object') {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return '';
}

function toJsonString(value) {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function parseJsonOrEmptyObject(value) {
  if (value && typeof value === 'object') {
    return value;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

function safeToolName(value) {
  if (typeof value !== 'string') {
    return 'unknown';
  }
  return value.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 128) || 'unknown';
}

function safeToolId(value, fallbackPrefix, index) {
  if (typeof value !== 'string' || !value) {
    return `${fallbackPrefix}_${index + 1}`;
  }
  return value.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 128) || `${fallbackPrefix}_${index + 1}`;
}

function collectInputToolNames(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools
    .filter((tool) => tool && typeof tool === 'object' && typeof tool.name === 'string' && tool.name)
    .map((tool) => safeToolName(tool.name));
}

function collectToolResultIds(messages) {
  const ids = [];
  if (!Array.isArray(messages)) {
    return ids;
  }

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object' || !Array.isArray(msg.content)) {
      continue;
    }

    for (const block of msg.content) {
      if (!block || typeof block !== 'object' || block.type !== 'tool_result') {
        continue;
      }
      ids.push(safeToolId(block.tool_use_id, 'tool_result', ids.length));
    }
  }

  return ids;
}

function collectDbxToolCalls(message) {
  const calls = Array.isArray(message && message.tool_calls) ? message.tool_calls : [];
  return calls
    .filter((call) => call && typeof call === 'object' && call.function && typeof call.function === 'object')
    .map((call, idx) => ({
      id: safeToolId(call.id, 'tool_call', idx),
      name: safeToolName(call.function.name),
    }));
}

function debugLogToolEvent(eventName, details) {
  if (!TOOL_DEBUG_ENABLED) {
    return;
  }

  const payload = {
    ts: new Date().toISOString(),
    event: eventName,
    ...details,
  };

  try {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } catch {
    // Best-effort debug logging only.
  }
}

function anthropicToolsToDbxTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }

  const mapped = tools
    .filter((tool) => tool && typeof tool === 'object' && typeof tool.name === 'string' && tool.name)
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: tool.input_schema && typeof tool.input_schema === 'object' ? tool.input_schema : { type: 'object', properties: {} },
      },
    }));

  return mapped.length > 0 ? mapped : undefined;
}

function anthropicToolChoiceToDbxToolChoice(toolChoice) {
  if (!toolChoice) {
    return undefined;
  }

  if (typeof toolChoice === 'string') {
    if (toolChoice === 'none') {
      return 'none';
    }
    if (toolChoice === 'any') {
      return 'required';
    }
    return 'auto';
  }

  if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'tool' && typeof toolChoice.name === 'string' && toolChoice.name) {
    return {
      type: 'function',
      function: {
        name: toolChoice.name,
      },
    };
  }

  return undefined;
}

function anthropicToDbxMessages(payload) {
  const out = [];

  if (payload.system) {
    const systemText = extractText(payload.system);
    if (systemText) {
      out.push({ role: 'system', content: systemText });
    }
  }

  const msgs = Array.isArray(payload.messages) ? payload.messages : [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') {
      continue;
    }

    const role = m.role === 'assistant' ? 'assistant' : 'user';

    if (typeof m.content === 'string') {
      out.push({ role, content: m.content });
      continue;
    }

    const blocks = Array.isArray(m.content) ? m.content : [];
    if (blocks.length === 0) {
      out.push({ role, content: '' });
      continue;
    }

    const textParts = [];
    const toolCalls = [];

    for (const block of blocks) {
      if (!block || typeof block !== 'object') {
        continue;
      }

      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
        continue;
      }

      if (role === 'assistant' && block.type === 'tool_use' && typeof block.name === 'string' && block.name) {
        const toolCallId = typeof block.id === 'string' && block.id ? block.id : `toolu_${Date.now()}_${toolCalls.length + 1}`;
        toolCalls.push({
          id: toolCallId,
          type: 'function',
          function: {
            name: block.name,
            arguments: toJsonString(block.input),
          },
        });
        continue;
      }

      if (role === 'user' && block.type === 'tool_result') {
        const toolCallId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
        out.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: extractTextForToolResult(block.content),
        });
      }
    }

    const textContent = textParts.join('\n').trim();
    if (role === 'assistant') {
      if (toolCalls.length > 0) {
        out.push({
          role: 'assistant',
          content: textContent,
          tool_calls: toolCalls,
        });
      } else {
        out.push({ role: 'assistant', content: textContent });
      }
    } else if (textContent || blocks.every((b) => b && typeof b === 'object' && b.type !== 'tool_result')) {
      out.push({ role: 'user', content: textContent });
    }
  }

  return out;
}

function mapStopReason(dbxFinishReason) {
  if (dbxFinishReason === 'tool_calls') {
    return 'tool_use';
  }
  if (dbxFinishReason === 'length') {
    return 'max_tokens';
  }
  return 'end_turn';
}

function dbxChoiceToAnthropicContent(choice) {
  const contentBlocks = [];
  const message = choice && choice.message && typeof choice.message === 'object' ? choice.message : {};

  if (typeof message.content === 'string' && message.content) {
    contentBlocks.push({
      type: 'text',
      text: message.content,
    });
  }

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const toolCall of toolCalls) {
    if (!toolCall || typeof toolCall !== 'object') {
      continue;
    }

    const fn = toolCall.function && typeof toolCall.function === 'object' ? toolCall.function : {};
    if (typeof fn.name !== 'string' || !fn.name) {
      continue;
    }

    contentBlocks.push({
      type: 'tool_use',
      id: typeof toolCall.id === 'string' && toolCall.id ? toolCall.id : `toolu_${Date.now()}_${contentBlocks.length + 1}`,
      name: fn.name,
      input: parseJsonOrEmptyObject(fn.arguments),
    });
  }

  return contentBlocks;
}

function writeJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function handleMessages(req, res) {
  const payload = await readJsonBody(req);
  const { endpoint: dbxEndpoint, route: endpointRoute } = resolveDbxEndpointForModel(payload.model);

  const inputToolNames = collectInputToolNames(payload.tools);
  const toolResultIds = collectToolResultIds(payload.messages);
  debugLogToolEvent('request.summary', {
    route: endpointRoute,
    model: typeof payload.model === 'string' ? payload.model : '',
    tool_count: inputToolNames.length,
    tool_names: inputToolNames,
    tool_choice_type: typeof payload.tool_choice === 'string'
      ? payload.tool_choice
      : (payload.tool_choice && typeof payload.tool_choice === 'object' && typeof payload.tool_choice.type === 'string'
        ? payload.tool_choice.type
        : ''),
    tool_result_count: toolResultIds.length,
    tool_result_ids: toolResultIds,
  });

  if (payload.stream === true) {
    // Force Claude Code to switch to non-streaming mode.
    writeJson(res, 404, {
      type: 'error',
      error: {
        type: 'not_found_error',
        message: 'Streaming is not supported by this Databricks proxy. Use non-streaming.',
      },
    });
    return;
  }

  const token = getBearerToken(req);
  if (!token) {
    writeJson(res, 401, {
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'Missing token. Provide x-api-key or Authorization: Bearer.',
      },
    });
    return;
  }

  const dbxPayload = {
    messages: anthropicToDbxMessages(payload),
    max_tokens: Number(payload.max_tokens || payload.max_output_tokens || DEFAULT_MAX_TOKENS),
  };

  const dbxTools = anthropicToolsToDbxTools(payload.tools);
  if (dbxTools) {
    dbxPayload.tools = dbxTools;
  }

  const dbxToolChoice = anthropicToolChoiceToDbxToolChoice(payload.tool_choice);
  if (dbxToolChoice !== undefined) {
    dbxPayload.tool_choice = dbxToolChoice;
  }

  if (typeof payload.temperature === 'number') {
    dbxPayload.temperature = payload.temperature;
  }

  const upstreamRes = await fetch(dbxEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(dbxPayload),
  });

  const upstreamText = await upstreamRes.text();
  let upstreamJson = null;
  try {
    upstreamJson = upstreamText ? JSON.parse(upstreamText) : null;
  } catch {
    upstreamJson = null;
  }

  if (!upstreamRes.ok) {
    writeJson(res, upstreamRes.status, {
      type: 'error',
      error: {
        type: 'api_error',
        message: upstreamJson && upstreamJson.message ? String(upstreamJson.message) : upstreamText || 'Databricks request failed',
      },
      upstream_status: upstreamRes.status,
      upstream_endpoint: dbxEndpoint,
      endpoint_route: endpointRoute,
    });
    return;
  }

  const choice = upstreamJson && Array.isArray(upstreamJson.choices) ? upstreamJson.choices[0] : null;
  const finishReason = choice && typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
  const usage = upstreamJson && upstreamJson.usage ? upstreamJson.usage : {};
  const anthropicContent = dbxChoiceToAnthropicContent(choice);
  const dbxToolCalls = collectDbxToolCalls(choice && choice.message ? choice.message : null);

  debugLogToolEvent('response.summary', {
    route: endpointRoute,
    finish_reason: finishReason || '',
    stop_reason: mapStopReason(finishReason),
    dbx_tool_call_count: dbxToolCalls.length,
    dbx_tool_calls: dbxToolCalls,
    anthropic_content_types: anthropicContent.map((block) => block && block.type).filter(Boolean),
  });

  const responseModel = typeof payload.model === 'string' && payload.model ? payload.model : 'claude-sonnet-4-6';

  writeJson(res, 200, {
    id: `msg_dbx_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: responseModel,
    content: anthropicContent.length > 0 ? anthropicContent : [{ type: 'text', text: '' }],
    stop_reason: mapStopReason(finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens || 0),
      output_tokens: Number(usage.completion_tokens || 0),
    },
    endpoint_route: endpointRoute,
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      writeJson(res, 200, {
        ok: true,
        endpoint_default: DBX_DEFAULT_ENDPOINT,
        endpoint_sonnet: DBX_SONNET_ENDPOINT,
        endpoint_opus: DBX_OPUS_ENDPOINT,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      await handleMessages(req, res);
      return;
    }

    writeJson(res, 404, {
      type: 'error',
      error: {
        type: 'not_found_error',
        message: `No route for ${req.method} ${url.pathname}`,
      },
    });
  } catch (err) {
    writeJson(res, 500, {
      type: 'error',
      error: {
        type: 'api_error',
        message: err && err.message ? err.message : 'Unhandled proxy error',
      },
    });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`dbx-anthropic-proxy listening on http://127.0.0.1:${PORT}\n`);
});
