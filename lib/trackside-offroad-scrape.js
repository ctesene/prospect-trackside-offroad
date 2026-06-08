/**
 * Trackside offroad results scraper (WORCS / tracksideresults.com legacy ASP portal).
 *
 * Index: `{base}results_main.asp`
 * Class results: `{base}results.asp?s={seriesId}&e={eventId}&c={classId}`
 * Lap times: `{base}laptimes.asp?s={seriesId}&e={eventId}&c={classId}&rnd=`
 *
 * Flow: series dropdown → events → class types → classes → results.asp + laptimes.asp
 * Persists OffroadRaceEvent, OffroadRaceEventClass, OffroadRaceEventClassResult,
 * and OffroadRaceLaptimes using the same field conventions as processes/mototally.
 */
const axios = require("axios");
const cheerio = require("cheerio");
const { Logging } = require("@vurb-tech/shared");
const prisma = require("../prisma/prisma");

const HTTP_TIMEOUT_MS = 60000;
const DELAY_MS = 450;

const PRISMA_TX_OPTIONS = {
  timeout: parseInt(
    process.env.TRACKSIDE_OFFROAD_PRISMA_TX_TIMEOUT_MS || "300000",
    10,
  ),
  maxWait: parseInt(
    process.env.TRACKSIDE_OFFROAD_PRISMA_TX_MAX_WAIT_MS || "60000",
    10,
  ),
};

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

const axiosHtml = axios.create({
  timeout: HTTP_TIMEOUT_MS,
  headers: {
    Accept: "text/html,application/xhtml+xml",
    "User-Agent": USER_AGENT,
  },
  maxRedirects: 5,
  validateStatus: (s) => s >= 200 && s < 400,
});

const MONTHS = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getParamFromUrl(href, param) {
  if (!href) return null;
  try {
    const url = new URL(href, "http://placeholder.local/");
    return url.searchParams.get(param);
  } catch {
    const m = String(href).match(new RegExp(`[?&]${param}=([^&]+)`));
    return m ? decodeURIComponent(m[1]) : null;
  }
}

function positionToNumber(str) {
  if (str == null || str === "") return null;
  const suffixRemoved = String(str)
    .trim()
    .replace(/st$/i, "")
    .replace(/nd$/i, "")
    .replace(/rd$/i, "")
    .replace(/th$/i, "");
  const n = Number(suffixRemoved);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** @returns {{ text: string, number: number | null } | null} */
function parsePlaceCell(placeText) {
  const raw = normalizeText(placeText);
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (upper === "DNF" || upper === "DNS" || upper === "DQ" || upper === "SC") {
    return { text: raw, number: null };
  }
  const n = positionToNumber(raw);
  if (n != null) return { text: raw, number: n };
  return { text: raw, number: null };
}

function parseUsDate(dateStr, yearFallback) {
  const m = String(dateStr || "")
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const month = parseInt(m[1], 10) - 1;
  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10) || parseInt(yearFallback, 10);
  if (!year) return null;
  return new Date(Date.UTC(year, month, day, 12, 0, 0));
}

/**
 * Parses "Friday, January 23, 2026" (Trackside offroad header) into UTC noon Date.
 */
function parseLongUsDate(dateStr) {
  const m = String(dateStr || "").match(
    /([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/,
  );
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (month == null || !Number.isFinite(day) || !Number.isFinite(year)) {
    return null;
  }
  return new Date(Date.UTC(year, month, day, 12, 0, 0));
}

function splitLocation(loc) {
  const s = normalizeText(loc);
  if (!s) return { city: "", state: "" };
  const parts = s.split(",").map((x) => x.trim());
  if (parts.length >= 2) {
    return { city: parts[0], state: parts[parts.length - 1] };
  }
  return { city: s, state: "" };
}

function extractYearFromSeriesName(seriesName) {
  const m = String(seriesName || "").match(/\b(20\d{2})\b/);
  return m ? m[1] : null;
}

/**
 * Resolve the results directory for a promoter.
 * WORCS example: http://www.tracksideresults.com/worcs/results/current/
 *
 * Accepts legacy scoringSystemUrl values such as:
 * - http://tracksideresults.com/worcs/results_main.asp
 * - http://www.tracksideresults.com/worcs/results/current/results_main.asp
 */
function resolvePromoterBaseUrl(promoter) {
  const slug = String(promoter.slug || "").trim();
  let raw = String(promoter.scoringSystemUrl || "").trim();

  if (!raw) {
    if (!slug) {
      throw new Error(
        `Promoter ${promoter.id} missing scoringSystemUrl and slug`,
      );
    }
    return `http://www.tracksideresults.com/${slug}/results/current/`;
  }

  raw = raw.replace(/[?#].*$/, "");
  raw = raw.replace(/\/(?:results_main|results|laptimes)\.asp$/i, "/");
  if (!raw.endsWith("/")) {
    raw = `${raw}/`;
  }

  try {
    const parsed = new URL(raw);

    if (parsed.hostname === "tracksideresults.com") {
      parsed.hostname = "www.tracksideresults.com";
    }

    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const siteSlug = slug || pathParts[0] || "";
    const resultsIdx = pathParts.indexOf("results");
    const hasResultsCurrent =
      resultsIdx !== -1 && pathParts[resultsIdx + 1] === "current";

    if (hasResultsCurrent) {
      parsed.pathname = `/${pathParts.slice(0, resultsIdx + 2).join("/")}/`;
    } else if (siteSlug) {
      parsed.pathname = `/${siteSlug}/results/current/`;
    }

    const out = parsed.toString();
    return out.endsWith("/") ? out : `${out}/`;
  } catch {
    if (!slug) {
      throw new Error(
        `Promoter ${promoter.id} has invalid scoringSystemUrl: ${raw}`,
      );
    }
    return `http://www.tracksideresults.com/${slug}/results/current/`;
  }
}

function buildResultsMainUrl(base, params = {}) {
  const url = new URL("results_main.asp", base);
  Object.entries(params).forEach(([key, value]) => {
    if (value != null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

function buildResultsUrl(base, params = {}) {
  const url = new URL("results.asp", base);
  Object.entries(params).forEach(([key, value]) => {
    if (value != null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

function buildLaptimesUrl(base, params = {}) {
  const url = new URL("laptimes.asp", base);
  Object.entries(params).forEach(([key, value]) => {
    if (value != null) {
      url.searchParams.set(key, String(value));
    }
  });
  if (!url.searchParams.has("rnd")) {
    url.searchParams.set("rnd", "");
  }
  return url.toString();
}

function scoringSystemEventId(year, eventId) {
  return `${year}-${eventId}`;
}

function parseSelectOptions(html, selectName, skipLabels = []) {
  const $ = cheerio.load(html);
  const skip = new Set(
    skipLabels.map((label) => normalizeText(label).toLowerCase()),
  );
  const out = [];

  $(`select[name='${selectName}'] option`).each((_, el) => {
    const value = $(el).attr("value") || "";
    const label = normalizeText($(el).text());
    if (!value || !label) return;
    if (skip.has(label.toLowerCase())) return;
    if (/please select/i.test(label)) return;
    out.push({ value, label });
  });

  return out;
}

function parseSeriesOptions(html) {
  return parseSelectOptions(html, "sp", ["Please Select a Series"]).map(
    (item) => ({
      ...item,
      seriesId: getParamFromUrl(item.value, "s"),
      year: extractYearFromSeriesName(item.label),
    }),
  );
}

function parseEventOptions(html) {
  return parseSelectOptions(html, "e", ["Please Select an Event"]).map(
    (item) => ({
      ...item,
      eventId: getParamFromUrl(item.value, "e"),
    }),
  );
}

function parseClassTypeOptions(html) {
  return parseSelectOptions(html, "ct", ["Please Select a Class Type"]).map(
    (item) => ({
      ...item,
      classTypeId: getParamFromUrl(item.value, "t"),
    }),
  );
}

function parseClassOptions(html) {
  return parseSelectOptions(html, "c", ["Please Select a Class"]).map(
    (item) => ({
      ...item,
      classId: getParamFromUrl(item.value, "c"),
    }),
  );
}

/**
 * @returns {{ name: string, location: string, date: Date | null, city: string, state: string, className: string }}
 */
function parseResultsPageHeader(html) {
  const $ = cheerio.load(html);
  const headerTexts = $("span.mainBigHeaderText")
    .toArray()
    .map((el) => normalizeText($(el).text()));

  const rawName = headerTexts[0] || "";
  const name = rawName.replace(/\s+Results$/i, "").trim();
  const location = headerTexts[1] || "";

  const dateText = normalizeText($("span.mainSmallHeaderText").first().text());
  const eventDate = parseLongUsDate(dateText);

  const classHeader = normalizeText(
    $("tr.tableDataHeader td")
      .filter((_, el) => /class results/i.test($(el).text()))
      .first()
      .text(),
  );
  const className = classHeader.replace(/\s*-\s*Class Results$/i, "").trim();

  const { city, state } = splitLocation(location);

  return {
    name,
    location,
    date: eventDate,
    city,
    state,
    className,
  };
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function parseRiderNameCell($, cell) {
  const html = decodeHtmlEntities($(cell).html() || "");
  const beforeBreak = html.split(/<br\s*\/?>/i)[0] || html;
  const inlineText = normalizeText(beforeBreak.replace(/<[^>]+>/g, " "));
  const name = normalizeText($(cell).find("a").first().text());

  let manufacturer = "UNK";
  const dashMatch = inlineText.match(/\s-\s([A-Za-z0-9]+)/);
  if (dashMatch) {
    manufacturer = dashMatch[1].toUpperCase();
  }

  const afterBreak = html.split(/<br\s*\/?>/i)[1] || "";
  const location = normalizeText(
    afterBreak.replace(/<[^>]+>/g, " ").replace(/^-\s*/, ""),
  );

  return { name, manufacturer, location };
}

function parseFastestLapCell(cellHtml) {
  const text = String(cellHtml || "").replace(/<br\s*\/?>/gi, "\n");
  const lines = text
    .replace(/<[^>]+>/g, " ")
    .split("\n")
    .map((line) => normalizeText(line))
    .filter(Boolean);

  const lapTime = lines[0] && lines[0] !== "-" ? lines[0] : null;
  let lapNumber = null;
  for (const line of lines) {
    const m = line.match(/lap\s*(\d+)/i);
    if (m) {
      lapNumber = parseInt(m[1], 10);
      break;
    }
  }
  return { fastestLap: lapTime, fastestLapLapNumber: lapNumber };
}

/**
 * @returns {Array<Record<string, unknown>>}
 */
function parseClassResults(html) {
  const $ = cheerio.load(html);
  const results = [];

  $("tr.tableData, tr.tableDataAlt").each((_, row) => {
    const cells = $(row).find("> td");
    if (cells.length < 8) return;

    const placeCell = normalizeText($(cells[0]).text());
    const place = parsePlaceCell(placeCell);
    if (!place) return;

    const riderNumber = normalizeText($(cells[1]).text()).replace(/^#/, "");
    const nameCell = cells[2];
    const riderLink = $(nameCell).find("a[href*='racer.asp']").first();
    const riderCell = parseRiderNameCell($, nameCell);
    const riderName = riderCell.name;
    if (!riderName) return;

    const href = riderLink.attr("href") || "";
    const promoterRiderId = getParamFromUrl(href, "racer");
    const manufacturer = riderCell.manufacturer;
    const location = riderCell.location;

    const overallText = normalizeText($(cells[3]).text());
    const overall = parsePlaceCell(overallText);

    const pointsText = normalizeText($(cells[4]).text());
    const pointsEarned = pointsText
      ? (() => {
          const n = parseInt(pointsText, 10);
          return Number.isFinite(n) ? n : null;
        })()
      : null;

    const { fastestLap, fastestLapLapNumber } = parseFastestLapCell(
      $(cells[5]).html(),
    );

    const lapsText = normalizeText($(cells[6]).text());
    const laps = lapsText
      ? (() => {
          const n = parseInt(lapsText, 10);
          return Number.isFinite(n) ? n : null;
        })()
      : null;

    const elapsedTime = normalizeText($(cells[7]).text()) || null;

    results.push({
      classPlace: place.text,
      classPlaceNumber: place.number,
      overallPosition: overall ? overall.text : null,
      overallPositionNumber: overall ? overall.number : null,
      pointsEarned,
      fastestLap,
      fastestLapLapNumber,
      laps,
      elapsedTime,
      riderNumber,
      name: riderName,
      promoterRiderId,
      manufacturer,
      location,
    });
  });

  return results;
}

function toOffroadClassResultData(r) {
  const placeStr =
    r.classPlace != null && String(r.classPlace).trim() !== ""
      ? String(r.classPlace).trim()
      : "";
  const placeNum = r.classPlaceNumber ?? null;

  return {
    place: placeStr || String(placeNum ?? ""),
    placeNumber: placeNum,
    overallPosition:
      r.overallPosition != null ? String(r.overallPosition) : null,
    overallPositionNumber: r.overallPositionNumber ?? null,
    pointsEarned: r.pointsEarned ?? null,
    fastestLap: r.fastestLap != null ? String(r.fastestLap) : null,
    fastestLapLapNumber: r.fastestLapLapNumber ?? null,
    laps: r.laps ?? null,
    elapsedTime: r.elapsedTime != null ? String(r.elapsedTime) : null,
    riderNumber: String(r.riderNumber ?? ""),
    riderName: String(r.name ?? ""),
    promoterRiderId:
      r.promoterRiderId != null ? String(r.promoterRiderId) : null,
    manufacturer: String(r.manufacturer ?? "UNK"),
    location: String(r.location ?? ""),
    score: null,
  };
}

/**
 * Each lap cell on laptimes.asp has three lines: lap time, gap, position-in-lap.
 * @returns {{ lapTime: string, timeBehind: string | null, positionInLap: number | null } | null}
 */
function parseLapCell(cellHtml) {
  const lines = decodeHtmlEntities(String(cellHtml || ""))
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((line) => normalizeText(line))
    .filter(Boolean);

  const lapTime = lines[0] || null;
  if (!lapTime) return null;

  const timeBehindRaw = lines[1] || null;
  const positionInLap = lines[2] ? parseInt(lines[2], 10) : null;
  let timeBehind = timeBehindRaw;
  if (
    positionInLap === 1 ||
    (timeBehindRaw &&
      /^0+[.:]0+[.:]0+$/i.test(timeBehindRaw.replace(/\s/g, "")))
  ) {
    timeBehind = null;
  }

  return {
    lapTime,
    timeBehind,
    positionInLap:
      positionInLap != null && Number.isFinite(positionInLap)
        ? positionInLap
        : null,
  };
}

/**
 * @returns {Map<string, Array<{ lapNumber: number, lapTime: string, timeBehind: string | null, positionInLap: number | null }>>}
 */
function parseLaptimes(html) {
  const $ = cheerio.load(html);
  /** @type {Map<string, Array<{ lapNumber: number, lapTime: string, timeBehind: string | null, positionInLap: number | null }>>} */
  const byRider = new Map();

  let lapCount = 0;
  $("td").each((_, el) => {
    const match = normalizeText($(el).text()).match(/^Lap\s+(\d+)$/i);
    if (match) {
      lapCount = Math.max(lapCount, parseInt(match[1], 10));
    }
  });
  if (!lapCount) return byRider;

  $("tr.tableData, tr.tableDataAlt").each((_, row) => {
    const $row = $(row);
    const link = $row.find("a[href*='racer.asp']").first();
    if (!link.length) return;

    const promoterRiderId = getParamFromUrl(link.attr("href"), "racer");
    if (!promoterRiderId) return;

    const tds = $row.find("> td");
    /** @type {Array<{ lapNumber: number, lapTime: string, timeBehind: string | null, positionInLap: number | null }>} */
    const laptimes = [];

    for (let lapNumber = 1; lapNumber <= lapCount; lapNumber++) {
      const cell = tds.eq(lapNumber);
      if (!cell.length) continue;
      const parsed = parseLapCell(cell.html() || "");
      if (!parsed) continue;
      laptimes.push({ lapNumber, ...parsed });
    }

    if (laptimes.length) {
      byRider.set(String(promoterRiderId), laptimes);
    }
  });

  return byRider;
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {Map<string, Array<{ lapNumber: number, lapTime: string, timeBehind: string | null, positionInLap: number | null }>>} lapMap
 */
function mergeLaptimesIntoRows(rows, lapMap) {
  for (const row of rows) {
    const id = row.promoterRiderId != null ? String(row.promoterRiderId) : "";
    row.laptimes = id && lapMap.has(id) ? lapMap.get(id) : [];
  }
}

/**
 * @param {unknown} laptimes
 * @returns {Array<{ lapNumber: number, lapTime: string, timeBehind: string | null, positionInLap: number | null }>}
 */
function toLaptimeCreateMany(laptimes) {
  if (!Array.isArray(laptimes) || !laptimes.length) return [];
  return laptimes.map((l) => ({
    lapNumber: l.lapNumber,
    lapTime: String(l.lapTime ?? ""),
    timeBehind: l.timeBehind != null ? String(l.timeBehind) : null,
    positionInLap:
      l.positionInLap != null && Number.isFinite(l.positionInLap)
        ? l.positionInLap
        : null,
  }));
}

/**
 * @param {Record<string, unknown>} r
 * @returns {Record<string, unknown>}
 */
function classResultCreatePayload(r) {
  const base = toOffroadClassResultData(r);
  const lapCreates = toLaptimeCreateMany(r.laptimes);
  if (!lapCreates.length) return base;
  return {
    ...base,
    OffroadRaceLaptimes: { create: lapCreates },
  };
}

async function fetchHtml(url) {
  Logging.info(`Trackside offroad GET ${url}`);
  const { data } = await axiosHtml.get(url, { responseType: "text" });
  return typeof data === "string" ? data : String(data);
}

function eventNeedsProcessing(existingOffroad, forceRescrape) {
  if (forceRescrape) return true;
  if (!existingOffroad) return true;
  return false;
}

/**
 * @param {import("@prisma/client").RacePromoter} promoter
 * @param {{ scoringSystemEventId?: string, forceRescrape?: boolean }} [options]
 */
async function scrapeTracksideOffroadPromoter(promoter, options = {}) {
  const onlySid = options.scoringSystemEventId || null;
  const forceRescrape = Boolean(options.forceRescrape);
  const base = resolvePromoterBaseUrl(promoter);
  const indexUrl = buildResultsMainUrl(base);

  Logging.info(
    `Trackside offroad: scraping promoter ${promoter.name} (${promoter.id})`,
    { indexUrl, scoringSystemEventId: onlySid || "(all)", forceRescrape },
  );

  const indexHtml = await fetchHtml(indexUrl);
  const seriesList = parseSeriesOptions(indexHtml);

  if (!seriesList.length) {
    Logging.warn(
      `Trackside offroad: no series found on index for ${promoter.name}`,
    );
    return;
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const series of seriesList) {
    if (!series.seriesId) continue;

    const year =
      series.year ||
      extractYearFromSeriesName(series.label) ||
      String(new Date().getUTCFullYear());

    await delay(DELAY_MS);
    const seriesHtml = await fetchHtml(
      buildResultsMainUrl(base, { s: series.seriesId }),
    );
    const events = parseEventOptions(seriesHtml);

    for (const event of events) {
      if (!event.eventId) continue;

      const sid = scoringSystemEventId(year, event.eventId);
      if (onlySid && sid !== onlySid) continue;

      let offroadRowFresh = await prisma.offroadRaceEvent.findFirst({
        where: {
          racePromoterId: promoter.id,
          scoringSystemEventId: sid,
        },
        orderBy: { createdAt: "asc" },
      });

      if (!eventNeedsProcessing(offroadRowFresh, forceRescrape)) {
        skipped++;
        continue;
      }

      await delay(DELAY_MS);
      const eventHtml = await fetchHtml(
        buildResultsMainUrl(base, { s: series.seriesId, e: event.eventId }),
      );
      const classTypes = parseClassTypeOptions(eventHtml);

      if (!classTypes.length) {
        Logging.warn(
          `Trackside offroad: no class types for event ${event.label} (${sid})`,
        );
        continue;
      }

      /** @type {Array<{ meta: { classId: string, label: string, classTypeId: string | null, classTypeName: string | null }, results: ReturnType<typeof parseClassResults> }>} */
      const scrapedClasses = [];
      /** @type {ReturnType<typeof parseResultsPageHeader> | null} */
      let eventHeader = null;

      for (const classType of classTypes) {
        if (!classType.classTypeId) continue;

        await delay(DELAY_MS);
        const classTypeHtml = await fetchHtml(
          buildResultsMainUrl(base, {
            s: series.seriesId,
            e: event.eventId,
            t: classType.classTypeId,
          }),
        );
        const classes = parseClassOptions(classTypeHtml);

        for (const cls of classes) {
          if (!cls.classId) continue;

          await delay(DELAY_MS);
          let resultsHtml;
          try {
            resultsHtml = await fetchHtml(
              buildResultsUrl(base, {
                s: series.seriesId,
                e: event.eventId,
                c: cls.classId,
              }),
            );
          } catch (err) {
            Logging.warn(
              `Trackside offroad: class ${cls.label} (${cls.classId}) failed: ${err.message}`,
            );
            continue;
          }

          const header = parseResultsPageHeader(resultsHtml);
          if (!eventHeader) {
            eventHeader = header;
          }

          const rows = parseClassResults(resultsHtml);
          if (!rows.length) {
            Logging.warn(
              `Trackside offroad: no rows for class ${cls.label} (${cls.classId})`,
            );
            continue;
          }

          await delay(DELAY_MS);
          try {
            const laptimesHtml = await fetchHtml(
              buildLaptimesUrl(base, {
                s: series.seriesId,
                e: event.eventId,
                c: cls.classId,
              }),
            );
            mergeLaptimesIntoRows(rows, parseLaptimes(laptimesHtml));
          } catch (err) {
            Logging.warn(
              `Trackside offroad: laptimes for class ${cls.label} (${cls.classId}) failed: ${err.message} — saving results without laps`,
            );
          }

          scrapedClasses.push({
            meta: {
              classId: cls.classId,
              label: header.className || cls.label,
              classTypeId: classType.classTypeId,
              classTypeName: classType.label,
            },
            results: rows,
          });
        }
      }

      const hasAnyResultRows = scrapedClasses.some((c) => c.results.length > 0);
      if (!hasAnyResultRows) {
        Logging.warn(
          `Trackside offroad: no parsed result rows for ${event.label} (${sid})`,
        );
        continue;
      }

      const eventDate =
        eventHeader?.date ||
        parseUsDate(event.label, year) ||
        new Date(Date.UTC(parseInt(year, 10), 0, 1, 12, 0, 0));

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      if (eventDate > tomorrow) {
        skipped++;
        continue;
      }

      const eventName = eventHeader?.name || event.label.split(" - ")[0].trim();
      const locDisplay =
        eventHeader?.location ||
        event.label.split(" - ").slice(1).join(" - ").trim() ||
        "Unknown";
      const city = eventHeader?.city || splitLocation(locDisplay).city;
      const state = eventHeader?.state || splitLocation(locDisplay).state;
      const eventUrl = buildResultsMainUrl(base, {
        s: series.seriesId,
        e: event.eventId,
      });

      offroadRowFresh = await prisma.offroadRaceEvent.findFirst({
        where: {
          racePromoterId: promoter.id,
          scoringSystemEventId: sid,
        },
        orderBy: { createdAt: "asc" },
      });

      const classesToPersist = scrapedClasses.filter((c) => c.results.length > 0);

      const persistResult = await prisma.$transaction(async (tx) => {
        if (!offroadRowFresh) {
          const dupOff = await tx.offroadRaceEvent.findFirst({
            where: {
              racePromoterId: promoter.id,
              scoringSystemEventId: sid,
            },
          });
          if (dupOff) {
            Logging.warn(
              `Trackside offroad: skip create — OffroadRaceEvent ${sid} already present`,
            );
            return "skipped";
          }

          await tx.offroadRaceEvent.create({
            data: {
              name: eventName,
              date: eventDate,
              endDate: null,
              location: locDisplay,
              city,
              state,
              eventUrl,
              scoringSystemEventId: sid,
              seriesId: series.seriesId,
              seriesName: series.label,
              racePromoterId: promoter.id,
              isHidden: false,
              OffroadRaceEventClasses: {
                create: classesToPersist.map((sc) => ({
                  name: sc.meta.label,
                  scoringSystemEventClassId: sc.meta.classId,
                  date: eventDate,
                  classTypeId: sc.meta.classTypeId,
                  classTypeName: sc.meta.classTypeName,
                  OffroadRaceEventClassResults: {
                    create: sc.results.map((r) => classResultCreatePayload(r)),
                  },
                })),
              },
            },
          });
          return "created";
        }

        const offroadRow = offroadRowFresh;

        await tx.offroadRaceEvent.update({
          where: { id: offroadRow.id },
          data: {
            name: eventName,
            date: eventDate,
            location: locDisplay,
            city,
            state,
            eventUrl,
            seriesId: series.seriesId,
            seriesName: series.label,
            updatedAt: new Date(),
          },
        });

        for (const sc of classesToPersist) {
          let orec = await tx.offroadRaceEventClass.findFirst({
            where: {
              offroadRaceEventId: offroadRow.id,
              scoringSystemEventClassId: sc.meta.classId,
            },
          });

          if (!orec) {
            orec = await tx.offroadRaceEventClass.create({
              data: {
                offroadRaceEventId: offroadRow.id,
                name: sc.meta.label,
                scoringSystemEventClassId: sc.meta.classId,
                date: eventDate,
                classTypeId: sc.meta.classTypeId,
                classTypeName: sc.meta.classTypeName,
              },
            });
          } else {
            await tx.offroadRaceEventClass.update({
              where: { id: orec.id },
              data: {
                name: sc.meta.label,
                date: eventDate,
                classTypeId: sc.meta.classTypeId,
                classTypeName: sc.meta.classTypeName,
              },
            });
            await tx.offroadRaceEventClassResult.deleteMany({
              where: { offroadRaceEventClassId: orec.id },
            });
          }

          for (const r of sc.results) {
            await tx.offroadRaceEventClassResult.create({
              data: {
                ...classResultCreatePayload(r),
                offroadRaceEventClassId: orec.id,
              },
            });
          }
        }

        return "updated";
      }, PRISMA_TX_OPTIONS);

      if (persistResult === "created") {
        created++;
        Logging.info(
          `Trackside offroad: created offroad event ${eventName} (${sid})`,
        );
      } else if (persistResult === "updated") {
        updated++;
        Logging.info(
          `Trackside offroad: updated offroad event ${eventName} (${sid})`,
        );
      } else {
        skipped++;
      }
    }
  }

  Logging.info(
    `Trackside offroad: promoter ${promoter.name} done — created ${created}, updated ${updated}, skipped ${skipped}`,
  );
}

/**
 * @param {{ siteSlug?: string, scoringSystemEventId?: string, forceRescrape?: boolean }} [options]
 */
async function scrapeAllTracksideOffroadPromoters(options = {}) {
  const where = {
    scoringSystemType: "trackside-offroad",
    isResultsEnabled: true,
  };
  if (options.siteSlug) {
    where.slug = options.siteSlug;
  }

  const promoters = await prisma.racePromoter.findMany({
    where,
    orderBy: { slug: "asc" },
  });

  Logging.info(
    `Trackside offroad: ${promoters.length} promoter(s) with scoringSystemType=trackside-offroad and isResultsEnabled=true`,
  );

  if (promoters.length === 0) {
    Logging.info(
      "Trackside offroad: no promoters to scrape (check RacePromoter rows)",
    );
    return;
  }

  const scrapeOpts = {
    scoringSystemEventId: options.scoringSystemEventId,
    forceRescrape: options.forceRescrape,
  };

  for (const p of promoters) {
    try {
      await delay(DELAY_MS);
      await scrapeTracksideOffroadPromoter(p, scrapeOpts);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      Logging.error(`Trackside offroad: promoter ${p.name} failed: ${msg}`);
      if (err && err.stack) console.error(err.stack);
    }
  }
}

module.exports = {
  scrapeAllTracksideOffroadPromoters,
  scrapeTracksideOffroadPromoter,
  resolvePromoterBaseUrl,
  parseSeriesOptions,
  parseEventOptions,
  parseClassTypeOptions,
  parseClassOptions,
  parseResultsPageHeader,
  parseClassResults,
  parseLaptimes,
  parseLapCell,
  mergeLaptimesIntoRows,
  buildLaptimesUrl,
  parseLongUsDate,
  splitLocation,
  scoringSystemEventId,
  toOffroadClassResultData,
};
