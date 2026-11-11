/**
 * i18n for the settings panel and the command labels.
 *
 * Locale files are keyed by normalised tags (`pt_BR`, `zh_CN`, `sr`) matching the Joplin
 * translation files, so one lookup path serves both. Resolution falls back tag → bare language →
 * `en`; a missing key never renders as `undefined` in a dropdown.
 */

export interface Messages {
  [key: string]: string;
}

export type Translator = (key: string, vars?: Record<string, string | number>) => string;

/** 38 locales, matching Joplin's own translation set. `en` is the source of truth. */
export const LOCALES = [
  "af",
  "ar",
  "ca",
  "cs",
  "da",
  "de",
  "el",
  "en",
  "es",
  "fa",
  "fi",
  "fr",
  "he",
  "hi",
  "hr",
  "hu",
  "is",
  "it",
  "ja",
  "ko",
  "lv",
  "nl",
  "no",
  "pl",
  "pt_BR",
  "pt_PT",
  "ro",
  "ru",
  "sl",
  "sr",
  "sv",
  "th",
  "tr",
  "ug",
  "uk",
  "vi",
  "zh_CN",
  "zh_TW",
] as const;

export const SOURCE_LOCALE = "en";

/**
 * `zh-cn` → `zh_CN`, `pt-BR` → `pt_BR`, `de-DE` → `de`, `sr-Latn-RS` → `sr`.
 * Returns `""` for anything unusable, so callers fall back on their own default.
 */
export function normalizeTag(tag: string | null | undefined): string {
  const raw = String(tag ?? "").trim().replace(/_/g, "-");
  if (!raw) return "";
  const [language, ...rest] = raw.split("-").filter(Boolean);
  if (!language || !/^[A-Za-z]{2,3}$/.test(language)) return "";
  const base = language.toLowerCase();
  const region = rest.find((part) => /^[A-Za-z]{2}$/.test(part));
  // A script subtag (`Latn`, `Cyrl`) is not a translated variant: drop to the bare language.
  const scriptOnly = !region && rest.some((part) => /^[A-Za-z]{4}$/.test(part));
  if (!region || scriptOnly) return base;
  return `${base}_${region.toUpperCase()}`;
}

/** The tag to use for this Joplin install, or `en` when the platform does not say. */
export function detectLocale(resolved?: string | null): string {
  let candidate = resolved;
  if (candidate === undefined) {
    try {
      candidate = Intl.DateTimeFormat().resolvedOptions().locale;
    } catch {
      candidate = null;
    }
  }
  const tag = normalizeTag(candidate);
  if (!tag) return SOURCE_LOCALE;
  if ((LOCALES as readonly string[]).includes(tag)) return tag;
  const base = normalizeTag(tag.split("_")[0]);
  if ((LOCALES as readonly string[]).includes(base)) return base;
  // `pt_PORTUGAL` is not a thing, but `pt_XX` still deserves Portuguese rather than English.
  const family = LOCALES.find((locale) => locale.split("_")[0] === base);
  return family ?? SOURCE_LOCALE;
}

/** Which locale file to load for a tag: exact match first, then language family. */
export function resolveLocale(tag: string | null | undefined): string {
  return detectLocale(tag);
}

/**
 * `{NAME}` interpolation. Unknown placeholders are left alone on purpose: a visible `{AGE}`
 * in the UI is a bug report, a silently blank string is a mystery.
 */
export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

/**
 * Build a translator. `messages` is the requested locale; `fallback` (usually English) fills
 * the gaps, and a key missing from both renders as the key itself.
 */
export function createTranslator(
  messages: Messages | null | undefined,
  options: { fallback?: Messages; onMissing?: (key: string) => void } = {},
): Translator {
  const primary = messages ?? {};
  const fallback = options.fallback ?? {};
  return (key, vars) => {
    const template =
      typeof primary[key] === "string" && primary[key] !== ""
        ? primary[key]
        : typeof fallback[key] === "string" && fallback[key] !== ""
          ? fallback[key]
          : undefined;
    if (template === undefined) {
      options.onMissing?.(key);
      return key;
    }
    return interpolate(template, vars);
  };
}
