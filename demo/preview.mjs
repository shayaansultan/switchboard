// The window in an ordinary browser, on the demo's invented accounts, to click
// through a change without quitting the installed app or touching a real
// profile: the same stand-in bridge and usage reports as `bun run demo`.
// Buttons that would reach the main process do nothing.
//
//   bun run preview            # then open http://localhost:4317
//   PORT=5000 bun run preview

const { bridge, state, usageReports, serveRenderer } = await import('./window-stub.mjs');
const reports = await usageReports();
const server = serveRenderer({ port: Number(process.env.PORT) || 4317, inject: bridge(state, reports) });
console.log(`Switchboard preview on http://localhost:${server.port}/`);
