const { Logging, Sentry } = require("@vurb-tech/shared");
const {
  scrapeAllTracksideOffroadPromoters,
} = require("../lib/trackside-offroad-scrape");

/** @type {string} */
const EVENT_TYPE = "SCRAPE_TRACKSIDE_OFFROAD_RESULTS";

/**
 * Runs a Trackside offroad results scrape for all RacePromoters with
 * scoringSystemType "trackside-offroad" and isResultsEnabled.
 *
 * @param {{ triggerSource?: string, requestedAt?: string, siteSlug?: string, scoringSystemEventId?: string, forceRescrape?: boolean } | null | undefined} payload
 */
async function runTracksideOffroadScrape(payload) {
  Logging.setProcessName("TRACKSIDE-OFFROAD");
  Logging.info("Trackside offroad: scrape job received", {
    triggerSource: payload?.triggerSource,
    requestedAt: payload?.requestedAt,
    siteSlug: payload?.siteSlug,
    scoringSystemEventId: payload?.scoringSystemEventId,
    forceRescrape: payload?.forceRescrape,
  });

  try {
    const siteSlug = payload?.siteSlug || process.env.SITE_SLUG || undefined;
    const scoringSystemEventId =
      payload?.scoringSystemEventId ||
      process.env.SCORING_SYSTEM_EVENT_ID ||
      undefined;
    const forceRescrape =
      payload?.forceRescrape === true ||
      process.env.FORCE_RESCRAPE === "1" ||
      process.env.FORCE_RESCRAPE === "true";

    await scrapeAllTracksideOffroadPromoters({
      siteSlug,
      scoringSystemEventId,
      forceRescrape,
    });

    Logging.info("Trackside offroad: scrape job finished");
  } catch (err) {
    const msg = err && (err.message || String(err));
    Logging.error(`Trackside offroad: scrape failed: ${msg}`);
    if (err && err.stack) console.error(err.stack);
    Sentry.captureException(err, {
      tags: { service: "trackside-offroad-listener" },
      extra: { payload },
    });
    throw err;
  }
}

module.exports = {
  EVENT_TYPE,
  runTracksideOffroadScrape,
};
