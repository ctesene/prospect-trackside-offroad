require("dotenv").config();

const { Logging, Sentry, Redis } = require("@vurb-tech/shared");
const {
  EVENT_TYPE,
  runTracksideOffroadScrape,
} = require("./handlers/trackside-offroad-handler");

const STREAM =
  process.env.REDIS_STREAM_FOR_TRACKSIDE_OFFROAD || "TRACKSIDE_OFFROAD_SCRAPE";
const GROUP_NAME = "TRACKSIDE_OFFROAD_SCRAPE";
const CONSUMER_NAME = `trackside_offroad_${process.pid}`;

function parseMessagePayload(rawPayload) {
  if (!rawPayload) return null;
  if (typeof rawPayload === "string") return JSON.parse(rawPayload);
  return rawPayload;
}

async function handleStreamMessage(message, { id, stream }) {
  Logging.info(
    `[TRACKSIDE-OFFROAD-LISTENER] Processing message id=${id}`,
    message,
  );

  try {
    const eventType = message?.eventType;
    const payload = parseMessagePayload(message?.payload);

    if (eventType === EVENT_TYPE) {
      await runTracksideOffroadScrape(payload);
    } else {
      Logging.warn(
        `[TRACKSIDE-OFFROAD-LISTENER] Unknown eventType="${eventType}" on ${stream}`,
      );
    }
  } catch (error) {
    Logging.error(
      `[TRACKSIDE-OFFROAD-LISTENER] Message failed id=${id}`,
      error,
    );
    Sentry.captureException(error, {
      tags: { service: "trackside-offroad-listener" },
      extra: {
        messageId: id,
        stream,
        eventType: message?.eventType,
      },
    });
  } finally {
    await Redis.acknowledgeAndDeleteMessage(stream, GROUP_NAME, id);
  }
}

async function main() {
  Logging.setProcessName("TRACKSIDE-OFFROAD-LISTENER");
  Logging.info(
    `Consumer "${CONSUMER_NAME}" listening on stream "${STREAM}"`,
  );

  await Redis.onStreamMessage(
    STREAM,
    GROUP_NAME,
    CONSUMER_NAME,
    handleStreamMessage,
  );
}

main().catch((error) => {
  Logging.error("[TRACKSIDE-OFFROAD-LISTENER] Fatal startup error", error);
  Sentry.captureException(error);
  process.exit(1);
});
