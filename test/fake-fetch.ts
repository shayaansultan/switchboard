// Types a test's stand-in for fetch as the real one. Bun's fetch also carries
// `preconnect`, which no stand-in needs, so it borrows the real one, taken
// before any test replaces the global.

const { preconnect } = fetch;

export function fakeFetch(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, { preconnect });
}
