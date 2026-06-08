#!/usr/bin/env node
/**
 * Scrape one Trackside offroad event for one promoter (local / CI test).
 *
 * Usage:
 *   npm run trackside-offroad:scrape:event -- --site <RacePromoter.slug> --event <year-eventId> [--force]
 *
 * Example:
 *   npm run trackside-offroad:scrape:event -- --site worcs --event 2026-1
 */
require("dotenv").config();

const { Logging } = require("@vurb-tech/shared");
const prisma = require("../prisma/prisma");
const {
  scrapeTracksideOffroadPromoter,
} = require("../lib/trackside-offroad-scrape");

function parseArgs() {
  const out = {
    siteSlug: process.env.SITE_SLUG || null,
    scoringSystemEventId: process.env.SCORING_SYSTEM_EVENT_ID || null,
    forceRescrape:
      process.env.FORCE_RESCRAPE === "1" ||
      process.env.FORCE_RESCRAPE === "true",
  };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--force") out.forceRescrape = true;
    else if (a === "--site" && process.argv[i + 1])
      out.siteSlug = process.argv[++i];
    else if (a === "--event" && process.argv[i + 1])
      out.scoringSystemEventId = process.argv[++i];
  }
  return out;
}

async function main() {
  const { siteSlug, scoringSystemEventId, forceRescrape } = parseArgs();

  if (!siteSlug) {
    console.error(
      "Missing --site <slug> (RacePromoter.slug, e.g. worcs). Env: SITE_SLUG",
    );
    process.exit(1);
  }
  if (!scoringSystemEventId) {
    console.error(
      "Missing --event <scoringSystemEventId> (e.g. 2026-1). Env: SCORING_SYSTEM_EVENT_ID",
    );
    process.exit(1);
  }

  Logging.setProcessName("TRACKSIDE-OFFROAD-SINGLE-EVENT");
  Logging.info("Trackside offroad single-event scrape", {
    siteSlug,
    scoringSystemEventId,
    forceRescrape,
  });

  const promoter = await prisma.racePromoter.findFirst({
    where: {
      slug: siteSlug,
      scoringSystemType: "trackside-offroad",
      isResultsEnabled: true,
    },
  });

  if (!promoter) {
    console.error(
      `No RacePromoter with slug="${siteSlug}", scoringSystemType=trackside-offroad, isResultsEnabled=true`,
    );
    process.exit(1);
  }

  await scrapeTracksideOffroadPromoter(promoter, {
    scoringSystemEventId,
    forceRescrape,
  });

  Logging.info("Trackside offroad single-event scrape finished");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
