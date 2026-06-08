require("dotenv").config();

const { Logging, Sentry, Redis } = require("@vurb-tech/shared");
const { EVENT_TYPE } = require("./handlers/trackside-offroad-handler");

const STREAM =
  process.env.REDIS_STREAM_FOR_TRACKSIDE_OFFROAD || "TRACKSIDE_OFFROAD_SCRAPE";

async function main() {
  Logging.setProcessName("TRACKSIDE-OFFROAD-RUNNER");

  try {
    const payload = {
      triggerSource:
        process.env.TRACKSIDE_OFFROAD_TRIGGER_SOURCE || "coolify-scheduled",
      requestedAt: new Date().toISOString(),
      siteSlug: process.env.SITE_SLUG || undefined,
    };

    await Redis.pushToStream(STREAM, EVENT_TYPE, payload);

    Logging.info("Queued Trackside offroad scrape event", {
      stream: STREAM,
      eventType: EVENT_TYPE,
      payload,
    });

    process.exit(0);
  } catch (error) {
    Logging.error("Failed to queue Trackside offroad scrape event", error);
    Sentry.captureException(error, {
      tags: { service: "trackside-offroad-runner" },
    });
    process.exit(1);
  }
}

main();
