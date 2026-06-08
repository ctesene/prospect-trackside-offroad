# Trackside offroad results process

Redis stream–driven job for Trackside offroad results scraping (WORCS and other `trackside-offroad` promoters).

## Architecture

- **Runner** (`trackside-offroad-runner.js`): Short-lived; scheduled in Coolify and enqueues work.
- **Listener** (`trackside-offroad-listener.js`): Long-running consumer that receives jobs and runs `handlers/trackside-offroad-handler.js`.

Event type on the stream: `SCRAPE_TRACKSIDE_OFFROAD_RESULTS`.

Default Redis stream: `TRACKSIDE_OFFROAD_SCRAPE` (override with `REDIS_STREAM_FOR_TRACKSIDE_OFFROAD`).

## Setup

1. Copy `.env.example` to `.env` and set `REDIS_URL` / Redis host vars and database URLs.
2. `npm install`
3. From the monorepo root, keep Prisma schema in sync (`npm run prisma:sync`).

## Coolify

Same Docker build pattern as `processes/mototally`: `COPY . .`, then `npm install` (with retries), `prisma generate`, and `verify:prisma-client`.

1. **Listener** (always on): build this Dockerfile; default command is `node trackside-offroad-listener.js` (`npm start`).
2. **Scheduled task**: run `npm run execute` (or `node trackside-offroad-runner.js`) on your cadence; it pushes one message to the Redis stream so the listener performs the scrape.
3. **Build secret**: `GITHUB_TOKEN` for `@vurb-tech/shared` (see other process repos).

## Scripts

| Script                                                                  | Purpose                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------- |
| `npm start`                                                             | Start the listener                                      |
| `npm run execute`                                                       | Enqueue a scrape job (runner)                           |
| `npm run trackside-offroad:scrape:event -- --site worcs --event 2026-1` | Scrape a single event locally                           |
| `npm run test:parse`                                                    | Parser unit tests                                       |
| `npm run verify:prisma-client`                                          | Assert Prisma client files exist (used in Docker build) |

TEST DEPLOY
