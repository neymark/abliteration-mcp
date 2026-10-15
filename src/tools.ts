/**
 * The MCP tool surface: one tool per public API route.
 *
 * Input schemas follow src/pages/api/v1/openapi.json.ts parameter for
 * parameter - same names, same enums, same bounds - so a value the host model
 * picks is forwarded to the query string unchanged. Path parameters become
 * required string inputs. Nothing is added that the API does not accept.
 *
 * Every description states the route's credit cost (from
 * src/lib/api/v1/pricing.ts) so the model can weigh a call before making it.
 *
 * Results are the server envelope verbatim, under a one-line cost/balance
 * header the model can quote to the user without a second call.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { apiGet, ApiError, type ClientConfig, type Envelope, type QueryValue } from './client.js';
import { createLogger } from './log.js';

const log = createLogger('abl:tools');

/** Upper bound on `limit`, matching MAX_LIMIT in src/lib/api/v1/queries.ts. */
const MAX_LIMIT = 1000;

/** Index ids the server accepts, canonical plus aliases (INDEX_ID_ENUM). */
const INDEX_IDS = [
  'dai', 'DAI',
  'freedom-velocity', 'FV', 'freedom_velocity',
  'weaponization', 'WEAP',
  'f2w-latency', 'F2W', 'f2w_latency',
] as const;

/** Sort keys shared by /models and /datasets. */
const CATALOG_SORTS = [
  'downloads', '-downloads',
  'likes', '-likes',
  'created', '-created',
  'created_at', '-created_at',
  'first_seen', '-first_seen',
  'first_seen_at', '-first_seen_at',
] as const;

const AUTHOR_SORTS = [
  'total_downloads', '-total_downloads',
  'downloads', '-downloads',
  'total_models', '-total_models',
  'models', '-models',
  'total_likes', '-total_likes',
  'likes', '-likes',
] as const;

const limit = (defaultLimit: number) =>
  z.number().int().min(1).max(MAX_LIMIT).optional()
    .describe(`Rows to return, 1 to ${MAX_LIMIT}. Default ${defaultLimit}.`);

const offset = z.number().int().min(0).optional().describe('Rows to skip. Default 0.');

const modelId = z.string().min(1)
  .describe('Model id as author/name, for example mlabonne/Qwen3-30B-A3B-abliterated.');

/** Where a tool call goes: a path under /api/v1 and its query string. */
interface Route {
  path: string;
  query?: Record<string, QueryValue>;
}

/** Percent-encode one path segment. Model ids carry a slash that must become %2F. */
const seg = (value: string): string => encodeURIComponent(value);

/**
 * Render a successful call as the tool result: a cost/balance header line,
 * then the full server envelope as JSON.
 */
export function formatResult(envelope: Envelope): CallToolResult {
  const balance = envelope.credits_remaining === null || envelope.credits_remaining === undefined
    ? 'unknown'
    : `${envelope.credits_remaining} cr`;
  const preview = envelope.metering === 'preview' ? ' (metering preview, not billed)' : '';
  const header = `cost: ${envelope.cost} cr${preview} · balance: ${balance}`;
  return {
    content: [{ type: 'text', text: `${header}\n\n${JSON.stringify(envelope, null, 2)}` }],
  };
}

/** Render a failed call as an MCP tool error the host model can read. */
export function formatError(error: unknown): CallToolResult {
  let text: string;
  if (error instanceof ApiError) {
    const meta = [
      error.status ? `HTTP ${error.status}` : null,
      error.code,
      error.requestId ? `request_id ${error.requestId}` : null,
    ].filter(Boolean).join(' · ');
    text = `${error.message}\n\n(${meta})`;
  } else {
    text = `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
  }
  return { isError: true, content: [{ type: 'text', text }] };
}

/**
 * Register one read-only API tool. The handler maps validated arguments to a
 * route, calls it, and formats either outcome - tools never throw to the SDK,
 * so the model always gets a readable message instead of a protocol error.
 */
function apiTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  config: ClientConfig,
  name: string,
  spec: { title: string; description: string; input: Shape },
  route: (args: z.infer<z.ZodObject<Shape>>) => Route,
): void {
  server.registerTool(
    name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.input,
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    // The SDK infers the argument type from `inputSchema`; inside this generic
    // wrapper it cannot be narrowed further, so the cast restates what the SDK
    // has already validated.
    (async (args: unknown): Promise<CallToolResult> => {
      const { path, query } = route(args as z.infer<z.ZodObject<Shape>>);
      try {
        return formatResult(await apiGet(config, path, query));
      } catch (error) {
        log('%s failed: %s', name, error instanceof Error ? error.message : String(error));
        return formatError(error);
      }
    }) as Parameters<McpServer['registerTool']>[2],
  );
}

/**
 * Register every abliteration.org tool on `server`. All of them share
 * `config`, so a missing key surfaces per call rather than at startup.
 */
export function registerTools(server: McpServer, config: ClientConfig): void {
  /* ---------- catalog ---------- */

  apiTool(server, config, 'search_models', {
    title: 'Search models',
    description:
      'Search the abliteration.org catalog of abliterated and uncensored LLMs (GET /models). ' +
      'Filter by M-code method, base family, author, license, download range and creation date. ' +
      'Delisted models are excluded unless delisted=dead|all. ' +
      'Cost: 5 credits up to 200 rows; 20 / 80 / 300 for larger pages, multiplied by ' +
      '1 + (offset/2500)^2. Filter narrowly rather than paging deep.',
    input: {
      method: z.string().optional().describe('M-code, case-insensitive, e.g. M4. See list_methods.'),
      family: z.string().optional().describe('Base family, e.g. qwen or llama.'),
      author: z.string().optional().describe('Publisher handle, case-insensitive.'),
      license: z.string().optional().describe('SPDX-ish license string as published.'),
      downloads_gte: z.number().int().optional().describe('Minimum downloads.'),
      downloads_lte: z.number().int().optional().describe('Maximum downloads.'),
      created_after: z.string().optional().describe('ISO-8601 date or timestamp, inclusive.'),
      created_before: z.string().optional().describe('ISO-8601 date or timestamp, inclusive.'),
      delisted: z.enum(['live', 'dead', 'all']).optional()
        .describe('live (default): on the Hub now. dead: delisted only. all: both.'),
      sort: z.enum(CATALOG_SORTS).optional()
        .describe('Bare key is the natural direction (most / newest first); a leading - flips it. Default downloads.'),
      limit: limit(50),
      offset,
    },
  }, (a) => ({ path: '/models', query: { ...a } }));

  apiTool(server, config, 'get_model', {
    title: 'Get model',
    description:
      'Full record for one model (GET /models/{id}): method classification and evidence, family, size, ' +
      'files, quantizations, benchmarks, README, author summary. Delisted models are served with ' +
      'is_delisted=1 and days_since_gone. Cost: 10 credits.',
    input: { id: modelId },
  }, (a) => ({ path: `/models/${seg(a.id)}` }));

  apiTool(server, config, 'list_methods', {
    title: 'List methods',
    description:
      'The M-code taxonomy of uncensoring methods (GET /methods): abliteration, weight editing, ' +
      'merges, fine-tunes, repackages, with model and download counts per code. Cost: 5 credits.',
    input: {},
  }, () => ({ path: '/methods' }));

  apiTool(server, config, 'get_method', {
    title: 'Get method',
    description:
      'One M-code (GET /methods/{id}) with counts, top authors and sample models. Cost: 1 credit.',
    input: { id: z.string().min(1).describe('M-code, e.g. M1, M4, M5-frankenstein, M-uncensored.') },
  }, (a) => ({ path: `/methods/${seg(a.id)}` }));

  apiTool(server, config, 'list_authors', {
    title: 'List authors',
    description:
      'Model publishers with aggregate model, download and like totals (GET /authors). ' +
      'Cost: 5-15 credits by rows returned.',
    input: {
      sort: z.enum(AUTHOR_SORTS).optional()
        .describe('Bare key is largest first; a leading - flips it. Default total_downloads.'),
      limit: limit(50),
      offset,
    },
  }, (a) => ({ path: '/authors', query: { ...a } }));

  apiTool(server, config, 'get_author', {
    title: 'Get author',
    description: 'One publisher with totals and their top models (GET /authors/{id}). Cost: 1 credit.',
    input: { id: z.string().min(1).describe('Publisher handle, e.g. mlabonne.') },
  }, (a) => ({ path: `/authors/${seg(a.id)}` }));

  apiTool(server, config, 'search_datasets', {
    title: 'Search datasets',
    description:
      'Alignment and uncensoring datasets (GET /datasets), filterable by workflow category, author ' +
      'and license. Cost: 5-15 credits by rows returned.',
    input: {
      category: z.string().optional().describe('Workflow stage, e.g. heal or extract.'),
      author: z.string().optional().describe('Publisher handle, case-insensitive.'),
      license: z.string().optional().describe('License string as published.'),
      sort: z.enum(CATALOG_SORTS).optional()
        .describe('Bare key is the natural direction; a leading - flips it. Default downloads.'),
      limit: limit(50),
      offset,
    },
  }, (a) => ({ path: '/datasets', query: { ...a } }));

  apiTool(server, config, 'get_dataset', {
    title: 'Get dataset',
    description:
      'One dataset with its files and passport, the plain-language summary (GET /datasets/{id}). ' +
      'Cost: 1 credit.',
    input: { id: z.string().min(1).describe('Dataset id as author/name, e.g. mlabonne/orpo-dpo-mix-40k.') },
  }, (a) => ({ path: `/datasets/${seg(a.id)}` }));

  apiTool(server, config, 'list_indices', {
    title: 'List indices',
    description:
      'All four flagship indices at once (GET /indices): DAI, Freedom Velocity, Weaponization and ' +
      'F2W Latency. Check `measured` before treating a value as a finding. Cost: 20 credits.',
    input: {},
  }, () => ({ path: '/indices' }));

  apiTool(server, config, 'get_index', {
    title: 'Get index',
    description:
      'One index with its full history series (GET /indices/{id}). Only dai has history today. ' +
      'Cost: 10 credits.',
    input: { id: z.enum(INDEX_IDS).describe('Index id or alias (DAI, FV, WEAP, F2W).') },
  }, (a) => ({ path: `/indices/${seg(a.id)}` }));

  apiTool(server, config, 'get_timeline', {
    title: 'Get timeline',
    description:
      'Curated field events, newest first (GET /timeline): delistings, takedowns, notable releases. ' +
      'Cost: 50 credits flat - the most expensive route; narrow with from/to.',
    input: {
      from: z.string().optional().describe('Inclusive lower bound on event date, ISO-8601.'),
      to: z.string().optional().describe('Inclusive upper bound on event date, ISO-8601.'),
      event_type: z.string().optional().describe('Event type, case-insensitive.'),
      limit: limit(100),
    },
  }, (a) => ({ path: '/timeline', query: { ...a } }));

  /* ---------- change streams ---------- */

  apiTool(server, config, 'list_delisted', {
    title: 'List delisted models',
    description:
      'Change stream of models Hugging Face no longer serves (GET /models/delisted), preserved at ' +
      'their final state. Pass since = the newest last_seen_at from a previous call to get only new ' +
      'casualties. Cost: 5 credits flat.',
    input: {
      since: z.string().optional().describe('ISO-8601 date or timestamp; rows with last_seen_at >= since.'),
      sort: z.enum(['recent', 'downloads']).optional()
        .describe('recent (default, newest disappearance first) or downloads (biggest first).'),
      limit: limit(50),
      offset,
    },
  }, (a) => ({ path: '/models/delisted', query: { ...a } }));

  apiTool(server, config, 'get_deletions_summary', {
    title: 'Deletions summary',
    description:
      'Aggregate of the 24-month Hugging Face deletion analysis (GET /models/historical-deletions/summary): ' +
      'total seen, total deleted, deletion rate, average lifespan, monthly losses, top-10 casualties. ' +
      'Cost: 20 credits.',
    input: {},
  }, () => ({ path: '/models/historical-deletions/summary' }));

  apiTool(server, config, 'list_deletions', {
    title: 'List historical deletions',
    description:
      'Paged list of models deleted from Hugging Face over the last 24 months ' +
      '(GET /models/historical-deletions/list). Rows are frozen at last sighting. Cost: 5 credits flat.',
    input: {
      since_month: z.string().regex(/^\d{4}-\d{2}$/).optional()
        .describe('YYYY-MM; rows with last_seen_month >= it.'),
      min_peak_downloads: z.number().int().min(0).optional()
        .describe('Only rows whose peak downloads >= this.'),
      sort: z.enum(['downloads', 'recent', 'lifespan']).optional()
        .describe('downloads (default, biggest first), recent (newest deaths first), lifespan (longest-lived first).'),
      limit: limit(50),
      offset,
    },
  }, (a) => ({ path: '/models/historical-deletions/list', query: { ...a } }));

  apiTool(server, config, 'list_readme_drifts', {
    title: 'List README drifts',
    description:
      'Every commit that changed one model\'s README on Hugging Face (GET /models/{id}/drifts), with ' +
      'size_delta between commits. Pass since_ts = the max commit_ts from a previous call for an ' +
      'incremental feed; fetch a version with get_readme_at. Cost: 5 credits flat.',
    input: {
      id: modelId,
      since_ts: z.number().int().optional().describe('Unix epoch seconds; rows with commit_ts >= it.'),
      limit: limit(50),
      offset,
    },
  }, ({ id, ...query }) => ({ path: `/models/${seg(id)}/drifts`, query }));

  apiTool(server, config, 'get_readme_at', {
    title: 'Get README at commit',
    description:
      'Wayback view: the exact README of one model at one commit sha (GET /models/{id}/readme-at/{commit}). ' +
      'Use a commit_sha from list_readme_drifts. Cost: 10 credits.',
    input: {
      id: modelId,
      commit: z.string().min(1).describe('README commit sha, from list_readme_drifts.'),
    },
  }, (a) => ({ path: `/models/${seg(a.id)}/readme-at/${seg(a.commit)}` }));

  apiTool(server, config, 'get_download_anomalies', {
    title: 'Download anomalies',
    description:
      'Models whose downloads jumped (spike, >= 2x) or fell (drop, <= 0.5x) against a baseline window ' +
      '(GET /market/anomalies), biggest movers first. Cost: 15 credits flat.',
    input: {
      window_days: z.number().int().min(1).max(365).optional().describe('Baseline distance in days. Default 7.'),
      min_baseline: z.number().int().min(1).optional()
        .describe('Only rows whose baseline downloads >= this. Default 1000.'),
      kind: z.enum(['spike', 'drop']).optional().describe('Filter to one class; omit for both.'),
      limit: limit(50),
      offset,
    },
  }, (a) => ({ path: '/market/anomalies', query: { ...a } }));

  apiTool(server, config, 'get_download_history', {
    title: 'Download history',
    description:
      'Per-model download timeline (GET /models/{id}/download-history), the raw series ' +
      'get_download_anomalies scans. Cost: 5 credits flat.',
    input: {
      id: modelId,
      days: z.number().int().min(0).max(365).optional()
        .describe('Window in days, max 365. 0 for full history. Default 90.'),
    },
  }, ({ id, ...query }) => ({ path: `/models/${seg(id)}/download-history`, query }));
}
