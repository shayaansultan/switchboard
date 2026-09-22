// Quote a value as one POSIX shell word. Single quotes take everything
// literally; an embedded single quote closes, escapes and reopens.
export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
