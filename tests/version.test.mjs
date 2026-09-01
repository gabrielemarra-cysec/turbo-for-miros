import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

test("manifest, inject.js and package.json agree on the version", () => {
  const manifest = JSON.parse(read("src/manifest.json")).version;
  const pkg = JSON.parse(read("package.json")).version;
  const inject = read("src/inject.js").match(/const VERSION = "([^"]+)"/)[1];
  assert.equal(inject, manifest);
  assert.equal(pkg, manifest);
});
