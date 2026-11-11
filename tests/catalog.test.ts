import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BUILTINS,
  CATALOG_TTL_MS,
  CUSTOM_PROVIDER,
  LOWEST,
  buildProviderList,
  effortsOf,
  isCatalogCacheFresh,
  languageOptions,
  modelsForProvider,
  parseCatalogCache,
  projectCatalog,
  resolveEndpointOnProviderChange,
  resolveReasoningDepth,
} from "../src/catalog";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sample = JSON.parse(readFileSync(resolve(root, "tests/fixtures/conformance/models-dev-sample.json"), "utf8")) as Record<string, unknown>;
// A synthetic full catalogue: the real sample replicated across id prefixes, so the
// scale assertions stay honest without committing a 5.8 MB snapshot.
const full = Object.fromEntries(
  Array.from({ length: 12 }, (_, index) =>
    Object.entries(sample).map(([id, provider]) => [`${id}-${index}`, provider])
  ).flat()
) as Record<string, unknown>;
const names = JSON.parse(readFileSync(resolve(root, "tests/fixtures/conformance/language-names.json"), "utf8")) as Record<string, string>;

const comparator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

describe("projectCatalog", () => {
  it("keeps every models.dev provider that has models", () => {
    const catalog = projectCatalog(sample);
    for (const id of Object.keys(sample)) expect(catalog.providers[id], id).toBeDefined();
    expect(catalog.providers.openai.models.length).toBeGreaterThan(5);
  });

  it("merges the built-ins that the catalogue does not carry", () => {
    const catalog = projectCatalog(sample);
    expect(catalog.providers["ollama-local"]).toBeDefined();
    expect(catalog.providers["ollama-local"].source).toBe("built-in");
    expect(catalog.providers["ollama-local"].api).toBe("http://127.0.0.1:11434/v1");
  });

  it("prefers the catalogue api base over the built-in one", () => {
    const catalog = projectCatalog({
      deepseek: { id: "deepseek", name: "DeepSeek", api: "https://api.deepseek.com/v2", models: { m: { id: "m", name: "M" } } },
    });
    expect(catalog.providers.deepseek.api).toBe("https://api.deepseek.com/v2");
    expect(catalog.providers.deepseek.source).toBe("models.dev");
  });

  it("skips templated api bases that are not literal URLs", () => {
    const catalog = projectCatalog({
      neon: { id: "neon", name: "Neon", api: "${NEON_AI_GATEWAY_BASE_URL}/v1", models: { m: { id: "m", name: "M" } } },
    });
    expect(catalog.providers.neon.api).toBe("");
  });

  it("collapses aliases onto the canonical id instead of listing both", () => {
    const catalog = projectCatalog({
      google: { id: "google", name: "Google", api: null, models: { a: { id: "a", name: "A" } } },
      "google-gemini": { id: "google-gemini", name: "Google Gemini", api: null, models: { b: { id: "b", name: "B" } } },
    });
    expect(catalog.providers["google-gemini"]).toBeUndefined();
    const ids = catalog.providers.google.models.map((model) => model.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("survives garbage without throwing", () => {
    for (const raw of [null, undefined, 42, "nope", [], { x: null }, { y: { models: "no" } }]) {
      expect(() => projectCatalog(raw)).not.toThrow();
    }
    expect(projectCatalog(null).providers["ollama-local"]).toBeDefined();
  });

  it("scales to the full catalogue", () => {
    const catalog = projectCatalog(full);
    expect(Object.keys(catalog.providers).length).toBeGreaterThan(Object.keys(sample).length);
  });
});

describe("effortsOf", () => {
  it("reads effort values and ignores toggle/budget declarations", () => {
    expect(effortsOf([{ type: "toggle" }, { type: "effort", values: ["low", "high"] }])).toEqual(["low", "high"]);
    expect(effortsOf([{ type: "toggle" }, { type: "budget_tokens", min: 1024 }])).toEqual([]);
    expect(effortsOf(undefined)).toEqual([]);
    expect(effortsOf([])).toEqual([]);
  });
});

describe("buildProviderList", () => {
  it("is one alphabetical list with no divider and no disabled row", () => {
    const list = buildProviderList(projectCatalog(sample));
    for (let i = 1; i < list.length; i += 1) {
      expect(comparator.compare(list[i - 1].label, list[i].label)).toBeLessThanOrEqual(0);
    }
    expect(list.some((option) => (option as { disabled?: boolean }).disabled)).toBe(false);
    expect(list.every((option) => option.value && option.label)).toBe(true);
  });

  it("has unique values", () => {
    const list = buildProviderList(projectCatalog(full));
    expect(new Set(list.map((option) => option.value)).size).toBe(list.length);
  });

  it("carries the api base so the endpoint can autofill", () => {
    const list = buildProviderList(projectCatalog(sample));
    expect(list.find((option) => option.value === "deepseek")?.api).toBe("https://api.deepseek.com");
  });
});

describe("modelsForProvider", () => {
  it("lists the provider's models alphabetically with no duplicates", () => {
    const catalog = projectCatalog(sample);
    const models = modelsForProvider(catalog, "openai");
    expect(models.length).toBeGreaterThan(0);
    expect(new Set(models.map((model) => model.value)).size).toBe(models.length);
    for (let i = 1; i < models.length; i += 1) {
      expect(comparator.compare(models[i - 1].label, models[i].label)).toBeLessThanOrEqual(0);
    }
  });

  it("returns an empty list for an unknown provider", () => {
    expect(modelsForProvider(projectCatalog(sample), "nope")).toEqual([]);
  });
});

describe("languageOptions", () => {
  it("labels every language with its name, not its raw code", () => {
    const options = languageOptions(names, "zh-CN");
    expect(options.length).toBe(Object.keys(names).length);
    const readable = options.filter((option) => option.label !== option.value);
    expect(readable.length).toBeGreaterThanOrEqual(Math.ceil(options.length * 0.9));
    expect(options.some((option) => option.value === "zh-CN" && /Chinese/.test(option.label))).toBe(true);
  });

  it("keeps a hand-configured language that the table does not know", () => {
    const options = languageOptions({ en: "English" }, "eo");
    expect(options.some((option) => option.value === "eo")).toBe(true);
  });

  it("never offers auto as a target", () => {
    const options = languageOptions({ auto: "Auto", en: "English" }, "en");
    expect(options.some((option) => /^auto$/i.test(option.label))).toBe(false);
  });

  it("has unique values and is sorted", () => {
    const options = languageOptions(names, "en");
    expect(new Set(options.map((option) => option.value)).size).toBe(options.length);
    for (let i = 1; i < options.length; i += 1) {
      expect(comparator.compare(options[i - 1].label, options[i].label)).toBeLessThanOrEqual(0);
    }
  });
});

describe("resolveEndpointOnProviderChange (R3)", () => {
  const catalog = projectCatalog(sample);

  it("fills the endpoint from the chosen provider", () => {
    expect(
      resolveEndpointOnProviderChange("deepseek", { endpoint: "https://api.openai.com/v1", endpointCustom: false }, catalog),
    ).toBe("https://api.deepseek.com");
  });

  it("keeps the current endpoint when the catalogue has no api base", () => {
    // `groq` publishes no api base and is not a built-in: nothing to fill in from.
    const bare = projectCatalog({ groq: { id: "groq", name: "Groq", api: null, models: { m: { id: "m", name: "M" } } } });
    expect(
      resolveEndpointOnProviderChange("groq", { endpoint: "https://proxy.example/v1", endpointCustom: false }, bare),
    ).toBe("https://proxy.example/v1");
  });

  it("never overwrites an endpoint the user typed", () => {
    expect(
      resolveEndpointOnProviderChange("deepseek", { endpoint: "https://proxy.example/v1", endpointCustom: true }, catalog),
    ).toBe("https://proxy.example/v1");
  });

  it("leaves the endpoint alone for the custom provider", () => {
    expect(
      resolveEndpointOnProviderChange(CUSTOM_PROVIDER, { endpoint: "https://x.example/v1", endpointCustom: false }, catalog),
    ).toBe("https://x.example/v1");
  });
});

describe("resolveReasoningDepth (R4)", () => {
  it("resolves the sentinel to the cheapest declared level", () => {
    expect(resolveReasoningDepth(LOWEST, ["none", "minimal", "low"])).toBe("none");
    expect(resolveReasoningDepth(LOWEST, ["medium", "minimal", "low"])).toBe("minimal");
    expect(resolveReasoningDepth(LOWEST, ["high", "low"])).toBe("low");
  });

  it("returns empty when the model declares no scale", () => {
    expect(resolveReasoningDepth(LOWEST, [])).toBe("");
  });

  it("passes an explicit level through untouched", () => {
    expect(resolveReasoningDepth("high", ["low", "high"])).toBe("high");
    expect(resolveReasoningDepth("medium", [])).toBe("medium");
  });

  it("is case-insensitive and deduplicates", () => {
    expect(resolveReasoningDepth(LOWEST, ["LOW", "low", "HIGH"])).toBe("low");
  });

  it("trusts the declared order for an unknown vocabulary", () => {
    expect(resolveReasoningDepth(LOWEST, ["standard", "extended"])).toBe("standard");
  });

  it("only ever emits a level the model actually offers", () => {
    const catalog = projectCatalog(sample);
    for (const provider of Object.values(catalog.providers)) {
      for (const model of provider.models) {
        const resolved = resolveReasoningDepth(LOWEST, model.efforts);
        if (model.efforts.length) expect(model.efforts).toContain(resolved);
        else expect(resolved).toBe("");
      }
    }
  });
});

describe("catalogue cache", () => {
  const now = 1_700_000_000_000;

  it("treats a fresh cache as fresh and an old one as stale", () => {
    expect(isCatalogCacheFresh({ fetchedAt: now - 1000, raw: {} }, now)).toBe(true);
    expect(isCatalogCacheFresh({ fetchedAt: now - CATALOG_TTL_MS - 1, raw: {} }, now)).toBe(false);
  });

  it("distrusts a clock that went backwards and an empty/missing cache", () => {
    expect(isCatalogCacheFresh({ fetchedAt: now + 60_000, raw: {} }, now)).toBe(false);
    expect(isCatalogCacheFresh(null, now)).toBe(false);
    expect(isCatalogCacheFresh({ fetchedAt: now, raw: null }, now)).toBe(false);
  });

  it("parses defensively", () => {
    expect(parseCatalogCache("{not json")).toBeNull();
    expect(parseCatalogCache("")).toBeNull();
    expect(parseCatalogCache(null)).toBeNull();
    expect(parseCatalogCache(JSON.stringify({ fetchedAt: 1, raw: { a: 1 } }))).toEqual({ fetchedAt: 1, raw: { a: 1 } });
  });
});

describe("built-ins", () => {
  it("every built-in has a usable https/http endpoint", () => {
    for (const [id, entry] of Object.entries(BUILTINS)) {
      expect(entry.api, id).toMatch(/^https?:\/\//);
      expect(entry.name.trim()).not.toBe("");
    }
  });
});
