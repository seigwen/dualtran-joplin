#!/usr/bin/env node
/**
 * Bundle the non-code assets the plugin needs at runtime into `dist/index.js`, then archive.
 *
 * `joplin-plugin-cli build` bundles exactly one entry point (`src/index.ts`) and writes the .jpl
 * in the same command — so a file dropped into `dist/` afterwards never reaches the archive, and
 * re-running the CLI would recompile `index.js` and erase the injection. This script therefore
 * does the last step itself: inject the locale table, the language names and the panel view
 * script as a `globalThis.__DUALTRAN__` assignment, then tar `dist/` into the plugin package.
 *
 * `npm run build`:
 *   node scripts/build-panel.js    compile the view script into dist/
 *   joplin-plugin-cli build        compile index.js, manifest, (a throwaway archive)
 *   node scripts/build-assets.js   inject assets + write the real archive
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const bundlePath = path.join(dist, "index.js");
const panelPath = path.join(dist, "dualtran-panel.js");

if (!fs.existsSync(bundlePath)) {
  console.error("dist/index.js is missing — run joplin-plugin-cli build first");
  process.exit(1);
}
if (!fs.existsSync(panelPath)) {
  console.error("dist/dualtran-panel.js is missing — run node scripts/build-panel.js first");
  process.exit(1);
}

const MARKER = "/* __DUALTRAN_ASSETS__ */";

const localesDir = path.join(root, "locales");
const messages = {};
for (const name of fs.readdirSync(localesDir).sort()) {
  if (!name.endsWith(".json")) continue;
  messages[name.replace(/\.json$/, "")] = JSON.parse(fs.readFileSync(path.join(localesDir, name), "utf8"));
}
const localeCount = Object.keys(messages).length;
if (localeCount < 38) {
  console.error(`expected 38 locales, found ${localeCount}`);
  process.exit(1);
}

const languages = JSON.parse(fs.readFileSync(path.join(root, "src", "data", "language-names.json"), "utf8"));
const panelScript = fs.readFileSync(panelPath, "utf8");

const payload = JSON.stringify({ messages, languages, panelScript });
// One statement, so removing a stale injection is a substring delete and re-running is idempotent.
const block = `${MARKER} globalThis.__DUALTRAN__ = ${payload};\n`;

let bundle = fs.readFileSync(bundlePath, "utf8");
const start = bundle.indexOf(MARKER);
if (start !== -1) {
  const end = bundle.indexOf("\n", bundle.indexOf("globalThis.__DUALTRAN__", start));
  bundle = bundle.slice(0, start) + bundle.slice(end + 1);
}
fs.writeFileSync(bundlePath, `${block}${bundle}`, "utf8");

if (!fs.readFileSync(bundlePath, "utf8").startsWith(MARKER)) {
  console.error("asset injection did not land at the top of dist/index.js");
  process.exit(1);
}

// Archive exactly like the CLI does: a flat tarball of dist/, portable entries, no leading dirs.
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const archive = path.join(root, `${manifest.name}.jpl`);
const files = fs
  .readdirSync(dist, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort();
execFileSync("tar", ["-cf", archive, "-C", dist, ...files], { stdio: "inherit" });

console.log(
  `assets: ${localeCount} locales, ${Object.keys(languages).length} language names, panel ${panelScript.length} bytes -> ${path.basename(archive)}`,
);
