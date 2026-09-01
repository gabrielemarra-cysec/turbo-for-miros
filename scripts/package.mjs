// Zip src/ into dist/turbo-for-miros-v<version>.zip, ready to load or release.

import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(path.join(root, "src/manifest.json"), "utf8")).version;
const out = path.join(root, "dist", `turbo-for-miros-v${version}.zip`);

mkdirSync(path.join(root, "dist"), { recursive: true });
rmSync(out, { force: true });
execFileSync("zip", ["-r", out, "."], { cwd: path.join(root, "src"), stdio: "inherit" });
console.log("\nwrote", path.relative(root, out));
