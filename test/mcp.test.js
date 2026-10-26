'use strict';
// MCP tv-canvas: arranca mcp/server.js contra una API falsa y llama a las herramientas por stdio con el cliente del SDK.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const sdk = path.join(__dirname, '..', 'mcp', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs');
const skip = !fs.existsSync(sdk) && 'falta mcp/node_modules/@modelcontextprotocol (npm --prefix mcp install)';

test('tv_power y tv_source mandan su orden a /api/cmd', { skip }, async () => {
  const { Client } = require(sdk + '/client/index.js');
  const { StdioClientTransport } = require(sdk + '/client/stdio.js');
  const got = [];
  const api = http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; });
    req.on('end', () => { got.push(JSON.parse(b)); res.end('{"tv":{"power":"off","src":"j"}}'); });
  });
  await new Promise(r => api.listen(0, '127.0.0.1', r));
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [path.join(__dirname, '..', 'mcp', 'server.js')],
    env: { ...process.env, TV_URL: 'http://127.0.0.1:' + api.address().port, TV_TOKEN: 't' },
  }));
  try {
    await client.callTool({ name: 'tv_power', arguments: { state: 'off' } });
    await client.callTool({ name: 'tv_power', arguments: { state: 'on' } });
    await client.callTool({ name: 'tv_source', arguments: { source: 'tv' } });
    await client.callTool({ name: 'tv_source', arguments: { source: 'jscreen' } });
    await client.callTool({ name: 'tv_channel', arguments: { number: 3 } });
    assert.deepEqual(got, [{ t: 'power', on: false }, { t: 'power', on: true }, { t: 'src', s: 'tv' }, { t: 'src', s: 'j' }, { t: 'channel', n: 3 }]);
  } finally { await client.close(); api.close(); }
});
