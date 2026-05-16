#!/usr/bin/env node
// Minimal MCP stdio client for claude-design-mcp. Pipes a JSON-RPC initialize +
// tools/call sequence into the exe and prints the matched response.
//
// Usage:
//   node scripts/design-mcp.mjs <tool_name> '<json_args>'
//   node scripts/design-mcp.mjs design_list '{"limit":3}'
//   node scripts/design-mcp.mjs design_create '{"brief":"...","tier":"fast"}'
//
// Returns the result envelope on stdout; nonzero exit on protocol error.
// Works on Windows where the shell-based shim's `timeout`/`sleep` combo flakes.

import { spawn } from 'node:child_process';

const [, , toolName, argsRaw = '{}'] = process.argv;
if (!toolName) {
  console.error('usage: design-mcp.mjs <tool_name> \'<json_args>\'');
  process.exit(2);
}

let toolArgs;
try {
  toolArgs = JSON.parse(argsRaw);
} catch (err) {
  console.error('invalid JSON args:', err.message);
  process.exit(2);
}

// Default to PATH lookup; override with CLAUDE_DESIGN_MCP_EXE for non-standard
// installs (e.g. uv tool installs into a per-user Scripts directory).
const exe = process.env.CLAUDE_DESIGN_MCP_EXE || 'claude-design-mcp';

const env = {
  ...process.env,
  CLAUDE_DESIGN_STUDIO_DIR: process.env.CLAUDE_DESIGN_STUDIO_DIR
    || `${process.env.USERPROFILE || ''}\\.claude-design\\studio`,
  CLAUDE_DESIGN_MODEL: process.env.CLAUDE_DESIGN_MODEL || 'claude-sonnet-4-6',
  CLAUDE_DESIGN_MODEL_OPUS: process.env.CLAUDE_DESIGN_MODEL_OPUS || 'claude-opus-4-7',
  CLAUDE_DESIGN_AUTO_RENDER: process.env.CLAUDE_DESIGN_AUTO_RENDER || '0',
};

const proc = spawn(exe, [], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

let stdoutBuf = '';
let resolved = false;
const startedAt = Date.now();
const overallTimeoutMs = Number(process.env.CLAUDE_DESIGN_TIMEOUT_MS) || 240_000;

const timer = setTimeout(() => {
  if (resolved) return;
  console.error('timeout after', overallTimeoutMs, 'ms');
  try { proc.kill('SIGKILL'); } catch {}
  process.exit(124);
}, overallTimeoutMs);

proc.stdout.setEncoding('utf8');
proc.stdout.on('data', (chunk) => {
  stdoutBuf += chunk;
  let nl;
  while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === 2 && !resolved) {
      resolved = true;
      clearTimeout(timer);
      process.stdout.write(JSON.stringify(msg, null, 2) + '\n');
      try { proc.stdin.end(); } catch {}
      try { proc.kill(); } catch {}
      const elapsed = Date.now() - startedAt;
      process.stderr.write(`done in ${elapsed}ms\n`);
      process.exit(0);
    }
  }
});

proc.stderr.on('data', (chunk) => process.stderr.write(chunk));
proc.on('error', (err) => {
  console.error('spawn error:', err.message);
  process.exit(1);
});
proc.on('exit', (code, signal) => {
  if (!resolved) {
    console.error('process exited before response. code=', code, 'signal=', signal);
    process.exit(code ?? 1);
  }
});

// Send initialize + initialized + tools/call as 3 distinct JSON-RPC frames.
const send = (obj) => proc.stdin.write(JSON.stringify(obj) + '\n');
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'newamp-design-cli', version: '1.0' },
  },
});
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: {
    name: toolName,
    arguments: { params: toolArgs },
  },
});
