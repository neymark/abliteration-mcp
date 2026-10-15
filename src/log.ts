/**
 * Debug logging, enabled with the conventional `DEBUG` variable.
 *
 * `DEBUG=abl:*` turns on every namespace, `DEBUG=abl:http` just the HTTP
 * layer. Patterns are comma- or space-separated and `*` matches any run of
 * characters, the same rules the `debug` package uses - without pulling it in
 * as a dependency for a dozen lines.
 *
 * Output goes to stderr unconditionally: over the stdio transport stdout is
 * the JSON-RPC stream, and a stray line there corrupts the session.
 */

/** A namespaced logger. Calling it is a no-op unless its namespace is enabled. */
export type Logger = (message: string, ...details: unknown[]) => void;

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function isEnabled(namespace: string): boolean {
  const raw = process.env.DEBUG;
  if (!raw) return false;
  let enabled = false;
  for (const part of raw.split(/[\s,]+/)) {
    if (!part) continue;
    if (part.startsWith('-')) {
      if (patternToRegExp(part.slice(1)).test(namespace)) return false;
    } else if (patternToRegExp(part).test(namespace)) {
      enabled = true;
    }
  }
  return enabled;
}

/**
 * Create a logger for `namespace` (for example `abl:http`). The DEBUG check
 * runs once, at creation, so a disabled logger costs one function call.
 */
export function createLogger(namespace: string): Logger {
  if (!isEnabled(namespace)) return () => {};
  return (message, ...details) => {
    const stamp = new Date().toISOString();
    console.error(`${stamp} ${namespace} ${message}`, ...details);
  };
}
