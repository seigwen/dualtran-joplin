import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LOCALES, SOURCE_LOCALE, createTranslator, detectLocale, interpolate, normalizeTag, resolveLocale } from "../src/i18n";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localesDir = resolve(root, "locales");

function readLocales(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const name of readdirSync(localesDir).filter((file) => file.endsWith(".json"))) {
    out[name.replace(/\.json$/, "")] = JSON.parse(readFileSync(resolve(localesDir, name), "utf8"));
  }
  return out;
}

const files = readLocales();
const english = files[SOURCE_LOCALE];

describe("normalizeTag", () => {
  it("maps platform spellings onto the shipped file names", () => {
    expect(normalizeTag("zh-cn")).toBe("zh_CN");
    expect(normalizeTag("zh-TW")).toBe("zh_TW");
    expect(normalizeTag("pt-br")).toBe("pt_BR");
    expect(normalizeTag("pt-PT")).toBe("pt_PT");
    expect(normalizeTag("de")).toBe("de");
  });

  it("drops a region-less script subtag to the bare language", () => {
    expect(normalizeTag("sr-Latn-RS")).toBe("sr_RS");
    expect(normalizeTag("sr-Latn")).toBe("sr");
    expect(normalizeTag("zh-Hans")).toBe("zh");
  });

  it("returns empty for junk instead of inventing a tag", () => {
    expect(normalizeTag("")).toBe("");
    expect(normalizeTag(null)).toBe("");
    expect(normalizeTag(undefined)).toBe("");
    expect(normalizeTag("12345")).toBe("");
    expect(normalizeTag("!!!")).toBe("");
  });
});

describe("detectLocale", () => {
  it("accepts an explicit platform locale", () => {
    expect(detectLocale("zh-CN")).toBe("zh_CN");
    expect(detectLocale("pt-BR")).toBe("pt_BR");
    expect(detectLocale("ja-JP")).toBe("ja");
  });

  it("falls back to the language family for an unknown region", () => {
    expect(detectLocale("es-AR")).toBe("es");
    expect(detectLocale("pt-AO")).toBe("pt_BR");
  });

  it("falls back to English when the platform says nothing usable", () => {
    expect(detectLocale("")).toBe(SOURCE_LOCALE);
    expect(detectLocale("xx-YY")).toBe(SOURCE_LOCALE);
    expect(detectLocale(null)).toBe(SOURCE_LOCALE);
  });

  it("reads Intl when no locale is given", () => {
    const detected = detectLocale();
    expect(LOCALES).toContain(detected);
  });

  it("resolveLocale always names a shipped file", () => {
    for (const tag of ["zh-CN", "pt-PT", "sr-Latn", "en-GB", "xx", ""]) {
      expect(LOCALES).toContain(resolveLocale(tag));
    }
  });
});

describe("interpolate", () => {
  it("substitutes named placeholders", () => {
    expect(interpolate("Lowest available ({RESOLVED})", { RESOLVED: "none" })).toBe("Lowest available (none)");
    expect(interpolate("{A}+{B}", { A: 1, B: 2 })).toBe("1+2");
  });

  it("leaves unknown placeholders visible rather than blanking them", () => {
    expect(interpolate("{MISSING} here", { OTHER: "x" })).toBe("{MISSING} here");
    expect(interpolate("{MISSING}", undefined)).toBe("{MISSING}");
  });
});

describe("createTranslator", () => {
  it("translates and interpolates", () => {
    const t = createTranslator(english);
    expect(t("labelProvider")).toBe("Provider");
    expect(t("statusRefreshed", { COUNT: 12 })).toBe("Catalogue updated (12 providers).");
  });

  it("falls back to English for a missing key, then to the key itself", () => {
    const t = createTranslator({ labelProvider: "Anbieter" }, { fallback: english });
    expect(t("labelProvider")).toBe("Anbieter");
    expect(t("saveButton")).toBe("Save");
    const bare = createTranslator({});
    expect(bare("nopeKey")).toBe("nopeKey");
  });

  it("reports a key that exists nowhere", () => {
    const missing: string[] = [];
    createTranslator({}, { fallback: english, onMissing: (key) => missing.push(key) })("nopeKey");
    expect(missing).toEqual(["nopeKey"]);
  });
});

describe("locale files", () => {
  it("ships exactly the 38 supported locales", () => {
    expect(LOCALES.length).toBe(38);
    expect(Object.keys(files).sort()).toEqual([...LOCALES].sort());
  });

  it("every locale has every English key, non-empty", () => {
    const keys = Object.keys(english).sort();
    expect(keys.length).toBeGreaterThan(30);
    for (const locale of LOCALES) {
      const file = files[locale];
      expect(Object.keys(file).sort(), locale).toEqual(keys);
      for (const key of keys) expect(String(file[key]).trim(), `${locale}.${key}`).not.toBe("");
    }
  });

  it("keeps every placeholder the English string has", () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(english)) {
        const expected = [...value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]);
        for (const token of expected) {
          expect(files[locale][key], `${locale}.${key}`).toContain(`{${token}}`);
        }
      }
    }
  });

  it("has real translations for the hand-written locales", () => {
    expect(files.zh_CN.labelProvider).toBe("服务商");
    expect(files.zh_TW.labelProvider).toBe("服務商");
    expect(files.zh_CN.saveButton).not.toBe(english.saveButton);
    expect(files.zh_TW.saveButton).not.toBe(english.saveButton);
  });

  it("does not leak CJK into a non-CJK locale", () => {
    for (const locale of LOCALES) {
      if (/^zh|^ja/.test(locale) || locale === SOURCE_LOCALE) continue;
      for (const [key, value] of Object.entries(files[locale])) {
        expect(/[\u3400-\u9fff\uf900-\ufaff]/.test(value), `${locale}.${key}`).toBe(false);
      }
    }
  });
});
