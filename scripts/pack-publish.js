// Build step for the npm package.
//
// Joplin's plugin-repo-cli installs the package, reads `publish/`, then takes the first .json as
// the manifest and the first .jpl as the plugin. Both must sit in that directory, flat.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const sourceManifest = path.join(root, "src", "manifest.json");
const manifest = JSON.parse(fs.readFileSync(sourceManifest, "utf8"));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
// joplin-plugin-cli names the archive after the npm package (`joplin-plugin-dualtran.jpl`);
// looking for a hand-written name silently packed an old build (v0.1.2) into v0.1.3.
const built = path.join(root, `${packageJson.name}.jpl`);

if (!fs.existsSync(built)) {
  console.error(`${packageJson.name}.jpl is missing — run \`npm run build\` first`);
  process.exit(1);
}

const outDir = path.join(root, "publish");
fs.mkdirSync(outDir, { recursive: true });

// The archive is the only thing users install. Refuse to publish a stale one: v0.1.3 shipped a
// v0.1.2 archive that had no settings panel because nobody checked the contents.
const archive = fs.readFileSync(built);
if (!archive.includes(Buffer.from("dualtran-panel.js"))) {
  console.error(`${built} does not contain dualtran-panel.js — rebuild before packing`);
  process.exit(1);
}
if (!archive.includes(Buffer.from(`"version": "${manifest.version}"`))) {
  console.error(`${built} does not declare version ${manifest.version} — rebuild before packing`);
  process.exit(1);
}

// Clear stale artifacts so the directory always matches the version being published.
for (const entry of fs.readdirSync(outDir)) {
  if (entry !== ".gitkeep") fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
}

fs.copyFileSync(built, path.join(outDir, `${manifest.id}.jpl`));
fs.copyFileSync(sourceManifest, path.join(outDir, "manifest.json"));
console.log(`packed publish/ (version ${manifest.version}, id ${manifest.id})`);
