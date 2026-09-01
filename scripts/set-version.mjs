// Sync a new version into manifest.json, inject.js and package.json.
// Usage: npm run version:set 1.0.1

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
  console.error("usage: npm run version:set <x.y.z>");
  process.exit(1);
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const patch = (file, from, to) => {
  const p = path.join(root, file);
  const next = readFileSync(p, "utf8").replace(from, to);
  writeFileSync(p, next);
  console.log("updated", file);
};

patch("src/manifest.json", /"version": "[^"]+"/, `"version": "${version}"`);
patch("package.json", /"version": "[^"]+"/, `"version": "${version}"`);
patch("src/inject.js", /const VERSION = "[^"]+"/, `const VERSION = "${version}"`);
