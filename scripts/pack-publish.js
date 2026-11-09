// Build step for the npm package.
//
// Joplin's plugin-repo-cli installs the package, reads `publish/`, then takes the first .json as
// the manifest and the first .jpl as the plugin. Both must sit in that directory, flat.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const sourceManifest = path.join(root, "src", "manifest.json");
const manifest = JSON.parse(fs.readFileSync(sourceManifest, "utf8"));
const built = path.join(root, "dualtran-joplin.jpl");

if (!fs.existsSync(built)) {
  console.error("dualtran-joplin.jpl is missing — run `npm run build` first");
  process.exit(1);
}

const outDir = path.join(root, "publish");
fs.mkdirSync(outDir, { recursive: true });

// Clear stale artifacts so the directory always matches the version being published.
for (const entry of fs.readdirSync(outDir)) {
  if (entry !== ".gitkeep") fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
}

fs.copyFileSync(built, path.join(outDir, `${manifest.id}.jpl`));
fs.copyFileSync(sourceManifest, path.join(outDir, "manifest.json"));
console.log(`packed publish/ (version ${manifest.version}, id ${manifest.id})`);
