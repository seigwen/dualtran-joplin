// Build step for the npm package: copy the freshly built .jpl into publish/ under its add-on id,
// which is the layout the Joplin plugin catalogue expects.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "src", "manifest.json"), "utf8"));
const built = path.join(root, "dualtran-joplin.jpl");

if (!fs.existsSync(built)) {
  console.error("dualtran-joplin.jpl is missing — run `npm run build` first");
  process.exit(1);
}

const target = path.join(root, "publish", `${manifest.id}.jpl`);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(built, target);
console.log(`packed ${path.relative(root, target)} (version ${manifest.version})`);
