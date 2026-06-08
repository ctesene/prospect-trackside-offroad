const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseSeriesOptions,
  parseEventOptions,
  parseClassTypeOptions,
  parseClassOptions,
  parseResultsPageHeader,
  parseClassResults,
  parseLaptimes,
  parseLongUsDate,
  splitLocation,
  resolvePromoterBaseUrl,
  scoringSystemEventId,
  mergeLaptimesIntoRows,
} = require("./trackside-offroad-scrape");

const FIXTURE_DIR = path.join(__dirname, "../data/worcs");

test("parseSeriesOptions reads WORCS series dropdown", () => {
  const html = fs.readFileSync(path.join(FIXTURE_DIR, "index.html"), "utf8");
  const series = parseSeriesOptions(html);

  assert.equal(series.length, 1);
  assert.equal(series[0].seriesId, "2");
  assert.equal(series[0].label, "2026 WORCS");
  assert.equal(series[0].year, "2026");
});

test("parseEventOptions reads events for a series", () => {
  const html = fs.readFileSync(path.join(FIXTURE_DIR, "index.html"), "utf8");
  const events = parseEventOptions(html);

  assert.ok(events.length >= 5);
  assert.equal(events[0].eventId, "1");
  assert.match(events[0].label, /SHORTY'S BREAKOUT GP/i);
});

test("parseLongUsDate parses Trackside offroad header dates", () => {
  const date = parseLongUsDate("Friday, January 23, 2026");
  assert.equal(date.toISOString(), "2026-01-23T12:00:00.000Z");
});

test("splitLocation splits city and state like MotoTally", () => {
  assert.deepEqual(splitLocation("SAN TAN VALLEY, AZ"), {
    city: "SAN TAN VALLEY",
    state: "AZ",
  });
});

test("resolvePromoterBaseUrl builds WORCS directory from slug", () => {
  const base = resolvePromoterBaseUrl({
    id: "x",
    slug: "worcs",
    scoringSystemUrl: "",
  });
  assert.equal(
    base,
    "http://www.tracksideresults.com/worcs/results/current/",
  );
});

test("resolvePromoterBaseUrl normalizes legacy WORCS scoringSystemUrl", () => {
  const base = resolvePromoterBaseUrl({
    id: "x",
    slug: "worcs",
    scoringSystemUrl: "http://tracksideresults.com/worcs/results_main.asp",
  });
  assert.equal(
    base,
    "http://www.tracksideresults.com/worcs/results/current/",
  );
});

test("resolvePromoterBaseUrl preserves explicit results/current path", () => {
  const base = resolvePromoterBaseUrl({
    id: "x",
    slug: "worcs",
    scoringSystemUrl:
      "http://www.tracksideresults.com/worcs/results/current/results_main.asp",
  });
  assert.equal(
    base,
    "http://www.tracksideresults.com/worcs/results/current/",
  );
});

test("scoringSystemEventId matches MotoTally year-round format", () => {
  assert.equal(scoringSystemEventId("2026", "1"), "2026-1");
});

test("parseResultsPageHeader extracts event metadata from results page", () => {
  const html = fs.readFileSync(
    path.join(FIXTURE_DIR, "results-open-c.html"),
    "utf8",
  );
  const header = parseResultsPageHeader(html);

  assert.match(header.name, /SHORTY'S BREAKOUT GP/i);
  assert.equal(header.location, "BLYTHE, CA");
  assert.equal(header.city, "BLYTHE");
  assert.equal(header.state, "CA");
  assert.equal(header.className, "OPEN C (MC)");
  assert.equal(header.date.toISOString(), "2026-01-23T12:00:00.000Z");
});

test("parseClassResults parses rider rows with class/overall/points", () => {
  const html = fs.readFileSync(
    path.join(FIXTURE_DIR, "results-open-c.html"),
    "utf8",
  );
  const rows = parseClassResults(html);

  assert.ok(rows.length >= 20);
  const winner = rows.find((r) => r.name === "CARTER DICKEY");
  assert.ok(winner);
  assert.equal(winner.classPlace, "1");
  assert.equal(winner.classPlaceNumber, 1);
  assert.equal(winner.overallPosition, "13");
  assert.equal(winner.overallPositionNumber, 13);
  assert.equal(winner.pointsEarned, 25);
  assert.equal(winner.manufacturer, "KTM");
  assert.equal(winner.location, "SAN TAN VALLEY, AZ");
  assert.equal(winner.fastestLap, "08:19.982");
  assert.equal(winner.fastestLapLapNumber, 2);
  assert.equal(winner.laps, 6);

  const dnf = rows.find((r) => r.name === "LOGAN WENNERBERG");
  assert.ok(dnf);
  assert.equal(dnf.classPlace, "DNF");
  assert.equal(dnf.overallPosition, "DNF");
});

test("parseLaptimes reads per-lap time, gap, and position", () => {
  const html = fs.readFileSync(
    path.join(FIXTURE_DIR, "laptimes-open-c.html"),
    "utf8",
  );
  const lapMap = parseLaptimes(html);

  assert.ok(lapMap.has("22190"));
  const winnerLaps = lapMap.get("22190");
  assert.equal(winnerLaps.length, 6);
  assert.deepEqual(winnerLaps[0], {
    lapNumber: 1,
    lapTime: "09:21.881",
    timeBehind: null,
    positionInLap: 1,
  });
  assert.deepEqual(winnerLaps[1], {
    lapNumber: 2,
    lapTime: "08:19.982",
    timeBehind: null,
    positionInLap: 1,
  });

  const chaserLaps = lapMap.get("21758");
  assert.ok(chaserLaps);
  assert.equal(chaserLaps[0].lapTime, "09:34.184");
  assert.equal(chaserLaps[0].timeBehind, "00:12.303");
  assert.equal(chaserLaps[0].positionInLap, 3);
});

test("mergeLaptimesIntoRows attaches laps to parsed class results", () => {
  const resultsHtml = fs.readFileSync(
    path.join(FIXTURE_DIR, "results-open-c.html"),
    "utf8",
  );
  const laptimesHtml = fs.readFileSync(
    path.join(FIXTURE_DIR, "laptimes-open-c.html"),
    "utf8",
  );
  const rows = parseClassResults(resultsHtml);
  mergeLaptimesIntoRows(rows, parseLaptimes(laptimesHtml));

  const winner = rows.find((r) => r.name === "CARTER DICKEY");
  assert.ok(winner);
  assert.equal(winner.laptimes.length, 6);
  assert.equal(winner.laptimes[5].lapTime, "08:39.056");
});
