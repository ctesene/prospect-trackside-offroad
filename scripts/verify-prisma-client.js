const fs = require("fs");
const path = require("path");

const expectedFiles = [
  path.join(__dirname, "..", "node_modules", ".prisma", "client", "default.js"),
  path.join(__dirname, "..", "node_modules", "@prisma", "client", "index.js"),
];

const missing = expectedFiles.filter((file) => !fs.existsSync(file));

if (missing.length > 0) {
  console.error("Prisma client is not generated in this container.");
  console.error("Missing files:");
  for (const file of missing) {
    console.error(`- ${file}`);
  }
  console.error("");
  console.error("Fix:");
  console.error("1) Rebuild/redeploy image so build runs prisma generate.");
  console.error("2) Ensure build can reach Prisma binaries (CA/proxy trust configured).");
  process.exit(1);
}

console.log("Prisma client check passed.");
