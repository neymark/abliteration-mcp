/**
 * @abliteration/mcp server.
 *
 * Exposes the abliteration.org public API (https://abliteration.org/api) as
 * MCP tools over stdio, for Claude Code, Claude Desktop, Cursor, Windsurf and
 * any other MCP host.
 *
 * Startup never fails for lack of a key: the host lists the tools either way,
 * and each call explains how to configure the key. A server that crashed on
 * launch would only show up as a red dot in the host's settings, which tells
 * the user much less.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_API_BASE, MISSING_KEY_MESSAGE, PACKAGE_VERSION, normaliseBase, type ClientConfig } from './client.js';
import { createLogger } from './log.js';
import { registerTools } from './tools.js';

const log = createLogger('abl:server');

/** Command-line options. The flag form wins over the environment. */
export interface CliOptions {
  apiKey: string | undefined;
  help: boolean;
  version: boolean;
}

/**
 * Parse argv. Accepts `--api-key KEY` and `--api-key=KEY`; unknown flags are
 * rejected so a typo does not silently start a keyless server.
 */
export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { apiKey: undefined, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--version' || arg === '-v') opts.version = true;
    else if (arg === '--api-key') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('--api-key needs a value');
      opts.apiKey = next;
      i++;
    } else if (arg.startsWith('--api-key=')) opts.apiKey = arg.slice('--api-key='.length);
    else throw new Error(`unknown argument: ${arg} (try --help)`);
  }
  return opts;
}

const HELP = `abliteration-mcp ${PACKAGE_VERSION}

MCP server for the abliteration.org public API, over stdio.

Usage: abliteration-mcp [--api-key KEY]

Environment:
  ABLITERATION_API_KEY   API key (abl_live_...). --api-key overrides it.
  ABLITERATION_API_BASE  API root, default ${DEFAULT_API_BASE}
  DEBUG=abl:*            debug logging to stderr

This program speaks JSON-RPC on stdin/stdout; it is meant to be launched by
an MCP host, not run interactively.
`;

/** Start the server on stdio. Resolves once the transport is connected. */
export async function main(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  // Help and version are the only things that may touch stdout: no
  // transport is connected yet when they print.
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  if (opts.version) {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }

  const envKey = process.env.ABLITERATION_API_KEY?.trim();
  const config: ClientConfig = {
    apiKey: opts.apiKey?.trim() || envKey || undefined,
    baseUrl: normaliseBase(process.env.ABLITERATION_API_BASE || DEFAULT_API_BASE),
  };

  if (!config.apiKey) {
    // stderr ends up in the host's MCP log, where a user looking for why
    // calls fail will find it.
    console.error(`abliteration-mcp: ${MISSING_KEY_MESSAGE}`);
  }
  log('base %s, key %s', config.baseUrl, config.apiKey ? `${config.apiKey.slice(0, 12)}...` : '(none)');

  const server = new McpServer(
    { name: 'abliteration', title: 'abliteration.org', version: PACKAGE_VERSION },
    {
      instructions:
        'Tools for the abliteration.org catalog of abliterated and uncensored LLMs: models, the M-code ' +
        'method taxonomy, authors, datasets, indices, and change streams (delistings, deletions, README ' +
        'drifts, download anomalies) that Hugging Face does not provide. Every call costs credits; each ' +
        'result begins with a "cost · balance" line you can report to the user.',
    },
  );
  registerTools(server, config);

  await server.connect(new StdioServerTransport());
  log('connected over stdio');
}
