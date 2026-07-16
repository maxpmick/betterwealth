import { createApp } from "./app";
import { loadConfig } from "./config";
import { startJobWorker } from "./jobs/worker";
import { createLogger } from "./lib/logger";
import { syncActiveConnections } from "./sync/scheduler";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const application = createApp(config);
const worker = startJobWorker(application.db, config);

const server = Bun.serve({
  hostname: config.API_HOST,
  port: config.API_PORT,
  fetch(request, bunServer) {
    const remoteAddress = bunServer.requestIP(request)?.address;
    return application.app.fetch(request, remoteAddress ? { remoteAddress } : {});
  },
});

logger.info("server.started", {
  host: server.hostname,
  port: server.port,
  environment: config.APP_ENV,
  database: config.databasePath,
});

let syncInProgress = false;
const runScheduledSync = async () => {
  if (syncInProgress) return;
  syncInProgress = true;
  try {
    const result = await syncActiveConnections(application.db, config);
    logger.info("sync.scheduled.complete", result);
  } catch (error) {
    logger.error("sync.scheduled.failed", { error });
  } finally {
    syncInProgress = false;
  }
};
const interval = setInterval(runScheduledSync, config.SYNC_INTERVAL_MINUTES * 60_000);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("server.stopping", { signal });
  clearInterval(interval);
  worker.stop();
  await server.stop(false);
  application.close();
  logger.info("server.stopped");
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
