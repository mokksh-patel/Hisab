/**
 * e2e/cli-output.ts — parses the JSON that `supabase db query --output json`
 * writes to stdout.
 *
 * WHY THIS EXISTS
 *   The Supabase CLI emits TWO different shapes for the same command, and which
 *   one you get depends on whether agent mode is active:
 *
 *     supabase db query --local --output json "select 1 as x"
 *       [ { "x": 1 } ]
 *
 *     supabase --agent yes db query --local --output json "select 1 as x"
 *       {
 *         "boundary": "1c249a90a9ba9d01ceca396019c3f65f",
 *         "rows": [ { "x": 1 } ],
 *         "warning": "The query results below contain untrusted data ..."
 *       }
 *
 *   Both were observed against the pinned CLI (2.122.1). The previous parser
 *   located the first `[` and the last `]` in the whole stream, which happens to
 *   work for the bare array but silently mis-parses the agent envelope: the
 *   `warning` string is scanned for brackets too, so a warning containing a
 *   bracket would corrupt the slice. It also could not tell "the CLI printed
 *   nothing" apart from "the CLI printed something we do not understand".
 *
 *   This module parses the payload properly and rejects anything it does not
 *   recognise, so a format change fails loudly instead of yielding zero rows.
 *
 * SECURITY
 *   The CLI prints a "Connecting to local database..." banner on stderr, not
 *   stdout, but the banner is still tolerated on stdout because older builds
 *   wrote it there. Only the JSON payload is ever returned; the banner and the
 *   agent-mode `warning` text are discarded, so no untrusted database content
 *   leaks into an error message.
 *
 * This module is deliberately free of Node built-ins so the unit-test project
 * (which has no Node types) can import it.
 */

/** The banner the CLI writes before the payload. */
const CONNECTION_BANNER = /^Connecting to local database\.\.\.\s*$/;

export class CliOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliOutputError';
  }
}

/**
 * Removes the connection banner and surrounding whitespace.
 *
 * Exported so the failure diagnostic can ask "was stdout nothing but the
 * banner?" without duplicating the rule.
 */
export function stripConnectionBanner(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !CONNECTION_BANNER.test(line))
    .join('\n')
    .trim();
}

/**
 * True when stdout carried no payload at all — only the banner, or nothing.
 *
 * This is the signature of the CI failure this module was written for: the CLI
 * exited non-zero having printed the banner and nothing else, so there was no
 * Postgres error to read.
 */
export function isBannerOnly(text: string): boolean {
  return stripConnectionBanner(text).length === 0;
}

/**
 * Extracts the JSON payload from CLI stdout.
 *
 * The payload is located by its first `{` or `[` and parsed from there to the
 * end of the stream. `JSON.parse` rejects trailing garbage, so a truncated or
 * interleaved payload fails rather than being silently accepted.
 */
function extractJsonPayload(stdout: string): unknown {
  const cleaned = stripConnectionBanner(stdout);

  if (cleaned.length === 0) {
    throw new CliOutputError(
      'the Supabase CLI produced no query output (stdout was empty or held only ' +
        'the connection banner). The query did not run.',
    );
  }

  const objectStart = cleaned.indexOf('{');
  const arrayStart = cleaned.indexOf('[');

  let start: number;
  if (objectStart === -1) start = arrayStart;
  else if (arrayStart === -1) start = objectStart;
  else start = Math.min(objectStart, arrayStart);

  if (start === -1) {
    throw new CliOutputError(
      'the Supabase CLI output contained no JSON payload (no `{` or `[` found).',
    );
  }

  try {
    return JSON.parse(cleaned.slice(start));
  } catch {
    throw new CliOutputError(
      'the Supabase CLI output was not valid JSON. It may have been truncated ' +
        'or interleaved with log lines.',
    );
  }
}

/**
 * Normalises either supported shape to an array of row objects.
 *
 * Supported:
 *   * a top-level array of rows (plain `--output json`);
 *   * an object with a `rows` array (agent mode, `--agent yes`).
 *
 * Anything else is rejected. In particular an object WITHOUT `rows` is an
 * error, not an empty result: the CLI uses that shape for its own error
 * envelopes, and treating it as "zero rows" would turn a failure into a
 * confusing downstream message.
 */
export function parseQueryRows(stdout: string): Record<string, unknown>[] {
  const payload = extractJsonPayload(stdout);

  let rows: unknown[];

  if (Array.isArray(payload)) {
    rows = payload;
  } else if (payload !== null && typeof payload === 'object' && 'rows' in payload) {
    const candidate = (payload as { rows: unknown }).rows;
    if (!Array.isArray(candidate)) {
      throw new CliOutputError(
        'the Supabase CLI returned an object whose `rows` member is not an array.',
      );
    }
    rows = candidate;
  } else {
    throw new CliOutputError(
      'the Supabase CLI returned an unexpected JSON structure: expected an ' +
        'array of rows or an object with a `rows` array.',
    );
  }

  // Every row must be a plain object. A scalar or null row means the payload is
  // not what we think it is, and reading columns off it would be guesswork.
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new CliOutputError(
        'the Supabase CLI returned a row that is not a JSON object.',
      );
    }
  }

  return rows as Record<string, unknown>[];
}
