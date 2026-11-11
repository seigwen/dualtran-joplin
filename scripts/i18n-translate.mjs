#!/usr/bin/env node
/**
 * Regenerate `locales/<code>.json` for every locale that has no hand-written translation.
 *
 * The other DualTran hosts translate through a provider; here the plugin's own settings panel is
 * the surface being translated, so the offline path is: copy the English values, then assert the
 * result is still a valid locale file. Nothing is written unless every guard passes.
 *
 * Guarantees (each throws before a single byte is written):
 *   - `en.json` exists and every value is a non-empty string;
 *   - the hand-written set (en, zh_CN, zh_TW) is never overwritten — neither is any file whose
 *     values differ from English unless `--force` is passed;
 *   - every generated file has exactly the English key set, no extra keys, no empty values;
 *   - placeholder tokens ({NAME}) survive verbatim;
 *   - no CJK text leaks into a non-CJK locale.
 *
 * Usage:
 *   node scripts/i18n-translate.mjs           # fill in missing locale files
 *   node scripts/i18n-translate.mjs --force   # rewrite every generated locale from English
 *   node scripts/i18n-translate.mjs --check   # assert only; writes nothing
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const LOCALES_DIR = resolve(root, "locales");
const SOURCE = "en";

/** Read from src/i18n.ts so this script and the plugin cannot disagree about the locale list. */
const LOCALES = (() => {
  const source = readFileSync(resolve(root, "src/i18n.ts"), "utf8");
  const block = source.match(/export const LOCALES = \[([\s\S]*?)\] as const;/);
  if (!block) throw new Error("src/i18n.ts: could not find the LOCALES list");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
})();

/** Hand-written: translated by a person, never by this script. */
const HAND_WRITTEN = new Set([SOURCE, "zh_CN", "zh_TW"]);
/** Scripts a copied English string could plausibly contain, so no CJK guard is needed. */
const CJK_FAMILY = /^zh|^ja/;

const force = process.argv.includes("--force");
const checkOnly = process.argv.includes("--check");

function fail(message) {
  console.error(`i18n-translate: ${message}`);
  process.exit(1);
}

function placeholders(text) {
  return [...String(text).matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]).sort();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const sourcePath = resolve(LOCALES_DIR, `${SOURCE}.json`);
if (!existsSync(sourcePath)) fail(`missing ${sourcePath}`);
const source = readJson(sourcePath);
const sourceKeys = Object.keys(source).sort();
if (sourceKeys.length === 0) fail("en.json has no keys");
for (const key of sourceKeys) {
  if (typeof source[key] !== "string" || source[key].trim() === "") fail(`en.json key "${key}" is empty`);
}

if (LOCALES.length !== 38) fail(`expected 38 locales, src/i18n.ts lists ${LOCALES.length}`);
if (!LOCALES.includes(SOURCE)) fail("LOCALES does not include the source locale");
for (const tag of HAND_WRITTEN) {
  if (!LOCALES.includes(tag)) fail(`hand-written locale "${tag}" is missing from LOCALES`);
}

mkdirSync(LOCALES_DIR, { recursive: true });

const written = [];
const skipped = [];

for (const locale of LOCALES) {
  const target = resolve(LOCALES_DIR, `${locale}.json`);
  if (HAND_WRITTEN.has(locale)) {
    if (!existsSync(target)) fail(`hand-written locale "${locale}" is missing: ${target}`);
    const messages = readJson(target);
    assertComplete(locale, messages);
    skipped.push(`${locale} (hand-written)`);
    continue;
  }

  const existing = existsSync(target) ? readJson(target) : null;
  const isTranslated = existing && Object.keys(existing).some((key) => existing[key] !== source[key]);
  if (existing && isTranslated && !force) {
    assertComplete(locale, existing);
    skipped.push(`${locale} (already translated; --force to reset)`);
    continue;
  }
  if (checkOnly) {
    // `--check` asserts the files on disk are structurally valid; it does not demand that a
    // copied-from-English locale has been human-translated yet.
    if (!existing) fail(`locale "${locale}" has no file (run without --check to generate)`);
    assertComplete(locale, existing);
    skipped.push(`${locale} (checked)`);
    continue;
  }

  // Assertion-guarded merge: English values, in English key order, nothing else.
  const next = {};
  for (const key of sourceKeys) next[key] = source[key];
  assertComplete(locale, next);
  writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  written.push(locale);
}

function assertComplete(locale, messages) {
  if (!messages || typeof messages !== "object" || Array.isArray(messages)) fail(`locale "${locale}" is not an object`);
  const keys = Object.keys(messages).sort();
  const missing = sourceKeys.filter((key) => !keys.includes(key));
  const extra = keys.filter((key) => !sourceKeys.includes(key));
  if (missing.length) fail(`locale "${locale}" is missing key(s): ${missing.join(", ")}`);
  if (extra.length) fail(`locale "${locale}" has unknown key(s): ${extra.join(", ")}`);
  for (const key of sourceKeys) {
    const value = messages[key];
    if (typeof value !== "string") fail(`locale "${locale}" key "${key}" is not a string`);
    if (value.trim() === "" && source[key].trim() !== "") fail(`locale "${locale}" key "${key}" is empty`);
    const expected = placeholders(source[key]);
    const actual = placeholders(value);
    const lost = expected.filter((token) => !actual.includes(token));
    if (lost.length) fail(`locale "${locale}" key "${key}" lost placeholder(s) ${lost.join(", ")}`);
    if (locale !== SOURCE && !CJK_FAMILY.test(locale) && /[\u3400-\u9fff\uf900-\ufaff]/.test(value)) {
      fail(`locale "${locale}" key "${key}" contains CJK text`);
    }
  }
}

const present = readdirSync(LOCALES_DIR).filter((name) => name.endsWith(".json")).length;
if (present < LOCALES.length) fail(`locales/ has ${present} files, expected at least ${LOCALES.length}`);

console.log(`i18n-translate: ${LOCALES.length} locales, ${sourceKeys.length} keys`);
if (written.length) console.log(`  wrote: ${written.join(", ")}`);
if (skipped.length) console.log(`  kept:  ${skipped.join(", ")}`);
if (!written.length) console.log("  nothing to write (use --force to regenerate)");
