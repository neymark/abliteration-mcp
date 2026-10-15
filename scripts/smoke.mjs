#!/usr/bin/env node
/**
 * End-to-end smoke test for @abliteration/mcp.
 *
 * Spawns the built server (bin/mcp.mjs) over stdio exactly as an MCP host
 * would, then:
 *   1. initialize            - handshake, prints server name and version
 *   2. tools/list            - needs no key; checks every expected tool exists
 *   3. tools/call list_methods - the one live call. Needs ABLITERATION_API_KEY
 *                              and costs 5 credits (while metering is billed).
 *
 * Exit 0 only when all three pass. Without a key, step 3 is checked for the
 * "set ABLITERATION_API_KEY" error instead; that run exits 2 unless --offline
 * is passed, so a missing key can never be mistaken for a full pass.
 *
 * Usage (from mcp/):
 *   npm run build
 *   ABLITERATION_API_KEY=abl_live_... node scripts/smoke.mjs
 *   node scripts/smoke.mjs --offline
 *
 * ABLITERATION_API_BASE and DEBUG are passed through to the server.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const offline = process.argv.includes('--offline');

const EXPECTED_TOOLS = [
  'search_models', 'get_model', 'list_methods', 'get_method', 'list_authors', 'get_author',
  'search_datasets', 'get_dataset', 'list_indices', 'get_index', 'get_timeline',
  'list_delisted', 'get_deletions_summary', 'list_deletions', 'list_readme_drifts',
  'get_readme_at', 'get_download_anomalies', 'get_download_history',
];

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

if (!existsSync(join(root, 'dist', 'index.js'))) {
  fail('dist/index.js not found - run `npm run build` first.');
}

// The SDK's stdio transport passes only a safe default environment to the
// child; forward the variables the server reads.
const env = getDefaultEnvironment();
for (const name of ['ABLITERATION_API_KEY', 'ABLITERATION_API_BASE', 'DEBUG']) {
  if (process.env[name]) env[name] = process.env[name];
}
const hasKey = Boolean(process.env.ABLITERATION_API_KEY?.trim());

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'bin', 'mcp.mjs')],
  env,
  stderr: 'inherit',
});
const client = new Client({ name: 'abliteration-mcp-smoke', version: '0.0.0' });

try {
  // 1. initialize
  await client.connect(transport);
  const info = client.getServerVersion();
  console.log(`initialize   ok - ${info?.name} ${info?.version}`);

  // 2. tools/list
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n));
  if (missing.length) fail(`tools/list is missing: ${missing.join(', ')}`);
  console.log(`tools/list   ok - ${tools.length} tools: ${names.join(', ')}`);

  // 3. tools/call list_methods
  const result = await client.callTool({ name: 'list_methods', arguments: {} });
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '';

  if (!hasKey) {
    if (!result.isError || !text.includes('ABLITERATION_API_KEY')) {
      fail(`expected a missing-key error from list_methods, got:\n${text}`);
    }
    console.log('list_methods ok - keyless call returned the configuration error:');
    console.log(indent(text));
    if (!offline) {
      console.error('\nLive call skipped: set ABLITERATION_API_KEY to run it (or pass --offline).');
      process.exitCode = 2;
    }
  } else {
    if (result.isError) fail(`list_methods returned an error:\n${text}`);
    if (!/^cost: \d+ cr/.test(text)) fail(`result is missing the cost header:\n${text}`);
    console.log('list_methods ok:');
    console.log(indent(text));
  }
} catch (error) {
  fail(error?.stack ?? String(error));
} finally {
  await client.close().catch(() => {});
}

function indent(s) {
  return s.split('\n').map((l) => `  ${l}`).join('\n');
}
