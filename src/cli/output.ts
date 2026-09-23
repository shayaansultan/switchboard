// The CLI's output contract. Success is the bare result as JSON on stdout.
// Failure is nothing on stdout, one JSON object on stderr with a stable
// code, and an exit status from a small fixed set. Agents branch on the code
// and the status; the message is for people.

import type { Profile } from '../types';

export interface ProfileRef {
  id: string;
  vendor: Profile['vendor'];
  name: string;
  isDefault: boolean;
}

export const ref = (p: Profile): ProfileRef => ({ id: p.id, vendor: p.vendor, name: p.name, isDefault: p.isDefault });

// 1 failed, 2 usage error, 3 not found, 4 refused by a precondition.
export type Exit = 1 | 2 | 3 | 4;

export interface CliFailure {
  error: string;
  message: string;
  hint?: string;
  candidates?: ProfileRef[];
  details?: unknown;
}

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exit: Exit,
    readonly extra: Omit<CliFailure, 'error' | 'message'> = {},
  ) {
    super(message);
  }

  failure(): CliFailure {
    return { error: this.code, message: this.message, ...this.extra };
  }
}

export const usageError = (message: string, details?: unknown): CliError =>
  new CliError('usage', message, 2, { hint: 'switchboard --help', ...(details === undefined ? {} : { details }) });
export const notFound = (code: string, message: string, hint?: string): CliError =>
  new CliError(code, message, 3, hint ? { hint } : {});
export const refused = (code: string, message: string, hint?: string): CliError =>
  new CliError(code, message, 4, hint ? { hint } : {});

// Messages the library modules throw, mapped to codes. Commands validate up
// front where they can; this is the backstop for what they cannot foresee.
const CLASSIFIED: [RegExp, string, Exit][] = [
  [/^no such profile$/, 'no-such-profile', 3],
  [/^the default profile (cannot be removed|is never written to)$/, 'default-profile', 4],
  [/^profiles are for different apps$/, 'vendor-mismatch', 4],
  [/^source and target are the same profile$/, 'same-profile', 4],
  [/^proxy routing is available for Codex/, 'wrong-vendor', 4],
  [/ is not installed$/, 'not-installed', 4],
  [/^Quit this desktop profile before launching/, 'desktop-running', 4],
  [/^This bucket has no enabled accounts/, 'bucket-empty', 4],
  [/^Bucket is stopped/, 'bucket-stopped', 4],
  [
    /unreachable|listener on an old worker port|worker lease without a receipt|conflicting worker lease|shutdown has not completed/,
    'bucket-unreachable',
    4,
  ],
  [/^Install the routing worker first/, 'proxy-not-installed', 4],
  [/^Proxy already installed/, 'proxy-installed', 4],
  [/^Account is not in this bucket$/, 'no-such-account', 3],
  [/^no terminal app found$/, 'no-terminal', 4],
  [/^An unrelated or differently installed launcher exists/, 'shim-conflict', 4],
  [/^Another process is editing/, 'store-locked', 4],
];

export function classify(error: unknown): CliError {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  for (const [pattern, code, exit] of CLASSIFIED) if (pattern.test(message)) return new CliError(code, message, exit);
  return new CliError('failed', message || 'Switchboard command failed', 1);
}

export interface Flags {
  json: boolean; // --json given explicitly; JSON is the default anyway
  human: boolean;
  yes: boolean;
  quiet: boolean;
}

// Where output goes. Tests capture it; the process writes to the console.
export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export const consoleIo: Io = { out: (text) => console.log(text), err: (text) => console.error(text) };

export class Output {
  constructor(
    readonly io: Io,
    readonly flags: Flags,
  ) {}

  // The command's result: JSON, or the human rendering under --human.
  result(value: unknown, human?: () => string): void {
    this.io.out(this.flags.human && human ? human() : JSON.stringify(value, null, 2));
  }

  // Plain text meant for a shell to consume (the `env` command).
  text(lines: string): void {
    this.io.out(lines);
  }

  // Progress for a person, on stderr. Silenced by --quiet.
  narrate(text: string): void {
    if (!this.flags.quiet) this.io.err(text);
  }

  fail(error: CliError): void {
    if (this.flags.human) {
      this.io.err(`error: ${error.message}${error.extra.hint ? `\n${error.extra.hint}` : ''}`);
    } else {
      this.io.err(JSON.stringify(error.failure()));
    }
  }
}

// An aligned text table for --human. Values render through String();
// null and undefined render empty.
export function table(rows: Record<string, unknown>[], columns: string[]): string {
  const cell = (value: unknown) => (value === null || value === undefined ? '' : String(value));
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (values: string[]) =>
    values
      .map((v, i) => v.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [line(columns), ...rows.map((r) => line(columns.map((c) => cell(r[c]))))].join('\n');
}
