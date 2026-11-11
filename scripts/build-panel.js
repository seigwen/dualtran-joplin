#!/usr/bin/env node
/**
 * Compile the panel view script into `dist/` before the plugin archive is built.
 *
 * `joplin-plugin-cli build` bundles only `src/index.ts`; anything else in the repository never
 * reaches the .jpl. So the panel script gets its own esbuild pass here, and `npm run build`
 * runs this first: `node scripts/build-panel.js && joplin-plugin-cli build`.
 *
 * The result is a plain IIFE — Joplin injects view scripts with `addScript`, which is not a
 * module loader, so the output must not be an ESM/CJS bundle.
 */
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");

esbuild
  .build({
    entryPoints: [path.join(root, "src", "panel.js")],
    outfile: path.join(root, "dist", "dualtran-panel.js"),
    bundle: false,
    platform: "browser",
    format: "iife",
    target: ["es2020"],
    legalComments: "none",
    logLevel: "warning",
  })
  .then(() => console.log("panel: dist/dualtran-panel.js"))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
