import { defaultConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { buildFetch, type AppContext } from "./app.ts";

const config = defaultConfig();

let db: ReturnType<typeof openDb> | null = null;
try {
  db = openDb(config.dbPath);
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(
    `[taskboard] FATAL: could not open database at ${config.dbPath}; ` +
      `serving liveness only, readiness and API routes will report 503. ` +
      `${err instanceof Error ? err.message : String(err)}`,
  );
}

const ctx: AppContext = { config, db };

const server: ReturnType<typeof Bun.serve> = Bun.serve({
  port: config.port,
  hostname: config.bind,
  async fetch(req: Request): Promise<Response> {
    return buildFetch(ctx)(req, server);
  },
  development: false,
});

// eslint-disable-next-line no-console
console.log(
  `[taskboard] serving ${config.buildMarker} (bun ${Bun.version}) at http://${config.bind}:${server.port}`,
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`[taskboard] received ${signal}, shutting down cleanly`);
  try {
    await server.stop(true);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[taskboard] error stopping server:", err);
  }
  try {
    if (db) db.close();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[taskboard] error closing database:", err);
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error("[taskboard] unhandledRejection:", reason);
});