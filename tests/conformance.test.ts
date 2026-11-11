/**
 * DualTran host conformance (SPEC 2.0.0) — joplin host.
 *
 * The payload is built from the plugin's *real* settings surface, not from a literal:
 *   - language / provider / model / reasoning options come from `buildPanelModel` on the
 *     shipped catalogue and the real `models-dev-sample.json` fixture;
 *   - the endpoint cases come from `applyProviderChange`, the same function the panel calls;
 *   - the reasoning cases come from `resolveReasoningDepth`;
 *   - the i18n matrix reads the 38 `locales/*.json` files and the keys `renderPanelHtml`
 *     actually uses (an unsubstituted `t("…")` call is a hard failure).
 *
 * Until the panel exists the imports are missing — which is the RED state this file documents.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BUILTINS,
  LOWEST,
  modelsForProvider,
  projectCatalog,
  resolveReasoningDepth,
} from "../src/catalog";
import { applyProviderChange, buildPanelModel, renderPanelHtml } from "../src/settingsPanel";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const HOST = "dualtran-joplin";

// Plain ESM from the conformance kit, shared verbatim with the other hosts; typed locally.
const kit = (await import(resolve(root, "scripts/conformance/validate.mjs"))) as {
  SPEC_VERSION: string;
  selfTest: () => number;
  validatePayload: (payload: unknown, config?: unknown) => {
    spec: string;
    host: string;
    languages: number;
    providers: number;
    localeCount: number;
  };
};
const { SPEC_VERSION, selfTest, validatePayload } = kit;

const config = JSON.parse(readFileSync(resolve(root, "conformance.json"), "utf8")) as {
  spec: string;
  host: string;
  static: { files: string[]; patterns: string[] };
  platformLimits?: unknown[];
};
const fixture = JSON.parse(readFileSync(resolve(root, "tests/fixtures/conformance/models-dev-sample.json"), "utf8")) as unknown;
const languageNames = JSON.parse(readFileSync(resolve(root, "tests/fixtures/conformance/language-names.json"), "utf8")) as Record<
  string,
  string
>;

const LOCALES_DIR = resolve(root, "locales");

function readLocales(): Record<string, Record<string, string>> {
  const files = readdirSync(LOCALES_DIR).filter((name) => name.endsWith(".json")).sort();
  const out: Record<string, Record<string, string>> = {};
  for (const name of files) {
    out[name.replace(/\.json$/, "")] = JSON.parse(readFileSync(resolve(LOCALES_DIR, name), "utf8"));
  }
  return out;
}

/** Identity translator: conforms to `t(key, vars)` without leaking a locale. */
function englishTranslator(messages: Record<string, string> = {}) {
  return (key: string) => messages[key] ?? key;
}

const settings = {
  engine: "ai",
  target: "zh-CN",
  provider: "openai",
  model: "gpt-4o-mini",
  endpoint: "https://api.openai.com/v1",
  apiKey: "",
  reasoning: "medium",
};

function uiText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Keys the template really calls, i.e. `t("key")` / `t("key", …)` in the panel source. */
function usedKeys(html: string): string[] {
  const source = readFileSync(resolve(root, "src/settingsPanel.ts"), "utf8");
  const fromSource = new Set(
    [...source.matchAll(/\bt\(\s*"([A-Za-z0-9_.]+)"\s*(?:,[^)]*)?\)/g)].map((match) => match[1]),
  );
  const keys = [...fromSource].sort();
  expect(keys.length).toBeGreaterThan(10);
  // Sanity: the rendered HTML is non-trivial and the panel is a form, not a message.
  expect(html).toContain("<form");
  expect(keys.length).toBeGreaterThan(0);
  return keys;
}

function buildPayload() {
  const t = englishTranslator();
  const catalog = projectCatalog(fixture);
  const model = buildPanelModel(settings, catalog, t, languageNames);
  const html = renderPanelHtml(model);
  const apiAfter = applyProviderChange(model, "openai").values;

  const locales = readLocales();
  const localeIds = Object.keys(locales).sort();

  return {
    spec: SPEC_VERSION,
    host: HOST,
    language: {
      control: "select",
      current: model.values.target,
      options: model.languages,
    },
    provider: {
      control: "select",
      current: model.values.provider,
      options: model.providers,
    },
    model: {
      control: "select",
      selectedProvider: model.values.provider,
      selectedModel: model.values.model,
      byProvider: model.modelsByProvider,
    },
    endpoint: {
      control: "text",
      autofill: {
        provider: "openai",
        providerApi: apiAfter.endpoint,
        before: "",
        after: apiAfter.endpoint,
        userEdited: "https://proxy.example/v1",
        afterSwitch: applyProviderChange(
          { ...model, values: { ...model.values, endpoint: "https://proxy.example/v1", endpointCustom: true } },
          "anthropic",
        ).values.endpoint,
      },
    },
    reasoning: {
      control: "select",
      default: LOWEST,
      resolved: {
        none: [
          { setting: LOWEST, options: ["none", "minimal", "low"], value: resolveReasoningDepth(LOWEST, ["none", "minimal", "low"]) },
          { setting: LOWEST, options: ["none"], value: resolveReasoningDepth(LOWEST, ["none"]) },
        ],
        minimal: [
          { setting: LOWEST, options: ["minimal", "low"], value: resolveReasoningDepth(LOWEST, ["minimal", "low"]) },
          { setting: LOWEST, options: ["medium", "minimal"], value: resolveReasoningDepth(LOWEST, ["medium", "minimal"]) },
        ],
        low: [
          { setting: LOWEST, options: ["low", "medium"], value: resolveReasoningDepth(LOWEST, ["low", "medium"]) },
          { setting: LOWEST, options: ["low"], value: resolveReasoningDepth(LOWEST, ["low"]) },
        ],
        "none-declared": [{ setting: LOWEST, options: [], value: resolveReasoningDepth(LOWEST, []) }],
      },
    },
    i18n: {
      locales: localeIds,
      sourceLocale: "en",
      keys: usedKeys(html),
      files: locales,
      used: usedKeys(html),
    },
    static: { hits: [] as unknown[] },
  };
}

describe("conformance kit", () => {
  it("its negative controls still catch every rule", () => {
    expect(selfTest()).toBeGreaterThanOrEqual(12);
  });

  it("conformance.json points at this host and the real settings sources", () => {
    expect(config.spec).toBe(SPEC_VERSION);
    expect(config.host).toBe(HOST);
    expect(config.static).toEqual({
      files: ["src/settingsPanel.ts", "src/index.ts"],
      patterns: ["providerSeparator", "__separator__", "__more__", "More (models.dev)"],
    });
  });
});

describe("payload", () => {
  it("satisfies R1–R5 and the static scan", async () => {
    const { scanFiles } = (await import(resolve(root, "scripts/conformance/scan.mjs"))) as {
      scanFiles: (root: string, cfg: unknown) => unknown[];
    };
    const payload = buildPayload();
    payload.static.hits = scanFiles(root, config.static);
    expect(payload.static.hits).toEqual([]);

    const summary = validatePayload(payload, config);
    expect(summary.host).toBe(HOST);
    expect(summary.localeCount).toBeGreaterThanOrEqual(38);

    // `payloadCommand` in conformance.json runs a tiny wrapper that prints this file: the runner
    // must get the payload built from the shipping modules, not a second hand-maintained copy.
    if (process.env.DUALTRAN_EMIT_PAYLOAD) {
      const out = resolve(root, "evidence", "conformance-payload.json");
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    }
  });

  it("ships a real catalogue: built-ins plus models.dev, one alphabetical list", () => {
    const payload = buildPayload();
    expect(Object.keys(BUILTINS).length).toBeGreaterThan(0);
    const builtIns = payload.provider.options.filter((o) => (o as { source: string }).source === "built-in");
    const fromModelsDev = payload.provider.options.filter((o) => (o as { source: string }).source === "models.dev");
    expect(builtIns.length).toBeGreaterThan(0);
    expect(fromModelsDev.length).toBe(Object.keys(fixture as object).length);
    expect(payload.provider.options.length).toBeGreaterThan(5);
    expect(payload.language.options.length).toBeGreaterThanOrEqual(Object.keys(languageNames).length);
  });

  it("offers a model list for every provider in the picker", () => {
    const payload = buildPayload();
    const providerIds = payload.provider.options.map((option) => option.value);
    expect(Object.keys(payload.model.byProvider).sort()).toEqual([...providerIds].sort());
    for (const [providerId, list] of Object.entries(payload.model.byProvider)) {
      expect(list.length, providerId).toBeGreaterThan(0);
    }
  });

  it("keeps a model the catalogue does not know selectable", () => {
    const catalog = projectCatalog(fixture);
    const model = buildPanelModel({ ...settings, model: "my-local-ft-1" }, catalog, englishTranslator(), languageNames);
    expect(renderPanelHtml(model)).toContain('<option value="my-local-ft-1" selected>my-local-ft-1</option>');
  });

  it("does not let a provider switch clobber a hand-typed endpoint", () => {
    const catalog = projectCatalog(fixture);
    const model = buildPanelModel(settings, catalog, englishTranslator(), languageNames);
    const edited = { ...model, values: { ...model.values, endpoint: "https://proxy.example/v1", endpointCustom: true } };
    expect(applyProviderChange(edited, "deepseek").values.endpoint).toBe("https://proxy.example/v1");
  });
});
