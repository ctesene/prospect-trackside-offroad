const { PrismaClient } = require("@prisma/client");
const { readReplicas } = require("@prisma/extension-read-replicas");

const prismaClientSingleton = () => {
  const readonlyUrls = [
    process.env.DATABASE_URL_READONLY_ONE,
    process.env.DATABASE_URL_READONLY_TWO,
  ].filter(Boolean);

  const client = new PrismaClient();
  if (!readonlyUrls.length) {
    return client;
  }

  return client.$extends(
    readReplicas({
      url: readonlyUrls,
    }),
  );
};

let globalForPrisma;
const prisma = globalForPrisma ?? prismaClientSingleton();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma = prisma;
}

module.exports = prisma;
