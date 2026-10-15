/**
 * HTTP client for the abliteration.org public API.
 *
 * The one place that talks to the network, so every tool gets the same error
 * mapping. Mirrors cli/src/lib/client.mjs, with two differences that come
 * from running inside an MCP host rather than a shell:
 *
 *   - No config-file fallback for the key. An MCP host passes configuration
 *     through `env` in its JSON config, so ABLITERATION_API_KEY (or the
 *     --api-key flag) is the whole story.
 *   - Failures are an `ApiError` with a message written for the host model to
 *     read and relay, not a shell exit code.
 *
 * The envelope shape follows src/lib/api/v1/response.ts on the server:
 *   { data, cost, credits_remaining, rate_limit_*, metering, request_id }
 */

import { createLogger } from './log.js';

const log = createLogger('abl:http');

/** Production API root. Every route lives under it. */
export const DEFAULT_API_BASE = 'https://abliteration.org/api/v1';

/** Version string sent in the user-agent; kept in step with package.json. */
export const PACKAGE_VERSION = '0.1.0';

/** Shown whenever a call is attempted without a key. */
export const MISSING_KEY_MESSAGE =
  'No API key configured. Set ABLITERATION_API_KEY to your abliteration.org key ' +
  '(or pass --api-key). Get one at https://abliteration.org/api';

const UNAUTHORIZED_MESSAGE =
  'Invalid or missing ABLITERATION_API_KEY. Get one at https://abliteration.org/api';

const OUT_OF_CREDITS_MESSAGE =
  'Out of credits. Top up at https://abliteration.org/shop/pricing';

/** Query values a tool may pass. `undefined` and `null` are dropped. */
export type QueryValue = string | number | boolean | null | undefined;

/** The success envelope every v1 route returns. */
export interface Envelope {
  data: unknown;
  cost: number;
  credits_remaining: number | null;
  rate_limit_limit?: number;
  rate_limit_remaining?: number;
  rate_limit_reset?: number;
  metering?: 'preview' | 'billed';
  request_id?: string;
  [extra: string]: unknown;
}

/**
 * A failed call, carrying the message the host model should see. `status`
 * is the HTTP status, or 0 when the request never reached the server.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;

  constructor(message: string, status: number, code: string, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/** Connection settings resolved once at startup. */
export interface ClientConfig {
  /** Bearer key, or undefined when none was configured. */
  apiKey: string | undefined;
  /** API root without a trailing slash, ending in /api/v1. */
  baseUrl: string;
}

/**
 * Normalise an API base URL.
 *
 * ABLITERATION_API_BASE is documented as the full API root
 * (`https://abliteration.org/api/v1`), but the CLI reads the same variable as
 * the bare host (`https://abliteration.org`). Accepting both means a shell
 * that already exports the variable for `abl` points this server at the same
 * deployment instead of at a 404.
 */
export function normaliseBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return /\/api\/v1$/.test(trimmed) ? trimmed : `${trimmed}/api/v1`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Perform an authenticated GET against `<baseUrl><path>` and return the
 * server's envelope untouched.
 *
 * `path` must already have its path parameters percent-encoded; model ids
 * contain a slash and the server requires it as `%2F`.
 *
 * @throws {ApiError} on a missing key, network failure, non-JSON body or any
 *   non-2xx status.
 */
export async function apiGet(
  config: ClientConfig,
  path: string,
  params: Record<string, QueryValue> = {},
): Promise<Envelope> {
  if (!config.apiKey) {
    throw new ApiError(MISSING_KEY_MESSAGE, 0, 'no_key');
  }

  const url = new URL(config.baseUrl + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }

  const started = Date.now();
  log('GET %s', url.toString());

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        accept: 'application/json',
        'user-agent': `abliteration-mcp/${PACKAGE_VERSION} node/${process.versions.node}`,
      },
    });
  } catch (error) {
    // Nothing reached the server, so nothing was charged.
    const detail = error instanceof Error ? error.message : String(error);
    log('network error after %dms: %s', Date.now() - started, detail);
    throw new ApiError(`Network error reaching ${url.origin}: ${detail}`, 0, 'network_error');
  }

  const text = await res.text();
  log('%d %s in %dms (%d bytes)', res.status, url.pathname, Date.now() - started, text.length);

  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(
      `Unexpected non-JSON response from ${url.pathname} (HTTP ${res.status}).`,
      res.status,
      'bad_response',
    );
  }

  if (!res.ok) {
    const obj = isRecord(body) ? body : {};
    const code = stringField(obj, 'error') ?? `http_${res.status}`;
    const requestId = stringField(obj, 'request_id') ?? res.headers.get('x-request-id') ?? undefined;
    const serverMessage = stringField(obj, 'message');

    if (res.status === 401 || res.status === 403) {
      throw new ApiError(UNAUTHORIZED_MESSAGE, res.status, code, requestId);
    }
    if (res.status === 402) {
      // Keep the server's sentence too: it names the exact cost and balance,
      // or explains that welcome credits do not cover the API.
      const message = serverMessage ? `${OUT_OF_CREDITS_MESSAGE}\n${serverMessage}` : OUT_OF_CREDITS_MESSAGE;
      throw new ApiError(message, res.status, code, requestId);
    }
    throw new ApiError(serverMessage ?? `HTTP ${res.status} (${code})`, res.status, code, requestId);
  }

  if (!isRecord(body) || !('data' in body)) {
    throw new ApiError(`Response from ${url.pathname} is missing the data envelope.`, res.status, 'bad_response');
  }
  return body as Envelope;
}
