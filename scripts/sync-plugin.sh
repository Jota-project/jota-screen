#!/bin/bash
# Copia el MCP al plugin (el plugin se distribuye autocontenido).
set -e
cd "$(dirname "$0")/.."
cp mcp/server.js plugin/tv-canvas/mcp/server.js
cp mcp/package.json plugin/tv-canvas/mcp/package.json
echo "plugin sincronizado"
