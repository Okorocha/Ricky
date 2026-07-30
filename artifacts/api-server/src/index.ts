import app from "./app";
import { logger } from "./lib/logger";
import { startTradeMonitoring, startTelegramPolling, startAutoScan } from "./bot/telegram";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Start fast in-process trade monitor (always — catches TP/SL in near real-time)
  if (process.env.TELEGRAM_TOKEN) {
    startAutoScan();
    startTradeMonitoring();
    startTelegramPolling();
    logger.info("Telegram bot, auto-scan, and trade monitoring started");
  } else {
    logger.warn("TELEGRAM_TOKEN not set — bot and trade monitoring disabled");
  }
});
