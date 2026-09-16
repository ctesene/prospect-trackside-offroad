const { PrismaClient } = require("@prisma/client");
const { readReplicas } = require("@prisma/extension-read-replicas");
const pkg = require("../package.json");

// Labels every session this process opens, so pg_stat_activity.application_name
// identifies the worker holding a connection instead of showing blank.
const APP_NAME = process.env.PRISMA_APP_NAME || pkg.name || "unknown-process";

// connection_limit is always applied so a leftover URL param cannot keep a
// quiet worker at 5. Override with PRISMA_CONNECTION_LIMIT when a process
// actually parallelizes queries. pool_timeout is a fallback only.
const POOL_LIMIT = process.env.PRISMA_CONNECTION_LIMIT || "2";
const POOL_FALLBACKS = {
  pool_timeout: process.env.PRISMA_POOL_TIMEOUT || "20",
};

// Always applied. Prisma holds onto every connection its pool has opened, so a
// brief burst of concurrency leaves those sockets parked as idle Postgres
// sessions for the remaining life of the process unless they expire.
const POOL_LIFETIMES = {
  max_idle_connection_lifetime:
    process.env.PRISMA_MAX_IDLE_CONNECTION_LIFETIME || "60",
  max_connection_lifetime: process.env.PRISMA_MAX_CONNECTION_LIFETIME || "1800",
};

// Rewrites the query string only, leaving the credential portion of the URL
// untouched so it is never re-encoded.
const withPoolParams = (url, role) => {
  if (!url) {
    return url;
  }

  const queryStart = url.indexOf("?");
  const base = queryStart === -1 ? url : url.slice(0, queryStart);
  const params = new URLSearchParams(
    queryStart === -1 ? "" : url.slice(queryStart + 1),
  );

  for (const [key, value] of Object.entries(POOL_FALLBACKS)) {
    if (!params.has(key)) {
      params.set(key, value);
    }
  }

  params.set("connection_limit", POOL_LIMIT);

  for (const [key, value] of Object.entries(POOL_LIFETIMES)) {
    params.set(key, value);
  }

  params.set("application_name", `${APP_NAME}:${role}`);

  return `${base}?${params.toString()}`;
};

const createClient = () => {
  const primaryUrl = withPoolParams(process.env.DATABASE_URL, "primary");
  const replicaUrls = [
    process.env.DATABASE_URL_READONLY_ONE,
    process.env.DATABASE_URL_READONLY_TWO,
  ]
    .filter(Boolean)
    .map((url, index) => withPoolParams(url, `replica-${index + 1}`));

  const client = primaryUrl
    ? new PrismaClient({ datasourceUrl: primaryUrl })
    : new PrismaClient();

  if (!replicaUrls.length) {
    // Keep $primary() available so call sites don't need to know whether
    // replicas are configured in this environment.
    return client.$extends({
      name: "primary-fallback",
      client: {
        $primary() {
          return client;
        },
      },
    });
  }

  return client.$extends(readReplicas({ url: replicaUrls }));
};

// Cached unconditionally: a second copy of this module means another set of
// pools that nothing will ever close.
const prisma = globalThis.__prospectPrisma__ ?? createClient();
globalThis.__prospectPrisma__ = prisma;

module.exports = prisma;
