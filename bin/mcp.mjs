#!/usr/bin/env node
/**
 * @abliteration/mcp entry point.
 *
 * Same shape as cli/bin/cli.mjs: the shebang file only delegates, so a stack
 * trace never blames a line in it. The server itself is compiled from
 * src/*.ts into dist/ by `npm run build` (run automatically on pack).
 *
 * stdout is the MCP wire. Nothing here may write to it - fatal errors go to
 * stderr, where the host (Claude Desktop, Cursor, ...) shows them in its log.
 */
import { main } from '../dist/index.js';

main(process.argv.slice(2)).catch((err) => {
  // A full stack only when debugging; a bad flag needs one line, not a trace.
  const detail = process.env.DEBUG ? (err?.stack ?? err) : (err?.message ?? err);
  console.error('abliteration-mcp:', detail);
  process.exit(1);
});
