#!/usr/bin/env bash
# Talk to the claude-design MCP server over stdio when the host has not
# loaded it. Usage:
#   scripts/design-call.sh <tool_name> '<json_arguments>'
# e.g.:
#   scripts/design-call.sh design_create '{"brief":"compact library view","tier":"fast"}'
#
# Returns only the result JSON-RPC envelope, not the handshake noise.

set -u

TOOL_NAME="${1:-}"
TOOL_ARGS="${2:-{}}"

if [[ -z "$TOOL_NAME" ]]; then
  echo "usage: design-call.sh <tool_name> '<json_args>'" >&2
  exit 2
fi

EXE="${CLAUDE_DESIGN_MCP_EXE:-claude-design-mcp.exe}"
export CLAUDE_DESIGN_STUDIO_DIR="${CLAUDE_DESIGN_STUDIO_DIR:-studio}"
export CLAUDE_DESIGN_MODEL="${CLAUDE_DESIGN_MODEL:-claude-sonnet-4-6}"
export CLAUDE_DESIGN_MODEL_OPUS="${CLAUDE_DESIGN_MODEL_OPUS:-claude-opus-4-7}"
export CLAUDE_DESIGN_AUTO_RENDER="${CLAUDE_DESIGN_AUTO_RENDER:-auto}"

REQUEST=$(cat <<JSONRPC
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"newamp-cli","version":"1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"$TOOL_NAME","arguments":{"params":$TOOL_ARGS}}}
JSONRPC
)

# Keep stdin open briefly so the server has time to flush its response.
timeout 180 bash -c "{ printf '%s\n' \"$REQUEST\"; sleep 165; } | \"$EXE\"" 2>/dev/null \
  | awk '/"id":2/ {print; found=1; exit} END {if(!found) exit 3}'
