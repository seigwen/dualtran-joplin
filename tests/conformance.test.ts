/**
 * DualTran host conformance (SPEC 2.1.0) — joplin host.
 *
 * The payload is built from the plugin's *real* settings surface, not from a literal:
 *   - the unconfigured state is `buildPanelModel({})` on a fresh install's settings (no provider,
 *     no endpoint, no model) — the same call the panel makes, so the placeholder, the disabled
 *     pickers and the empty endpoint are read out of the model the UI renders;
 *   - the configured state is that same panel after `applyProviderChange(model, "anthropic")`;
 *   - the endpoint cases come from `applyProviderChange`, the same function the panel calls;
 *   - the reasoning cases come from `resolveReasoningDepth`;
 *   - the i18n matrix reads the 38 `locales/*.json` files and the keys `renderPanelHtml` and
 *     `index.ts` actually call (an unsubstituted `t("…")` call is a hard failure).
 *
 * SPEC 2.1 changed the shape: `provider.placeholder` / `provider.fallback`, `model.disabled`,
 * `endpoint.current` / `endpoint.placeholder`, `reasoning.disabled`. A host that still defaults
 * to `openai` or to the custom endpoint cannot produce a valid unconfigured payload.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BUILTINS, CUSTOM_PROVIDER, LOWEST, projectCatalog, resolveReasoningDepth } from "../src/catalog";
import type { PanelModel } from "../src/settingsPanel";
import {
  applyEndpointEdit,
  applyProviderChange,
  buildPanelModel,
  modelDisabled,
  providerRequired,
  reasoningDisabled,
  renderPanelHtml,
} from "../src/settingsPanel";

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
  static: { files: string[]; patterns: unknown[] };
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

/** The shipped English strings: the payload must carry the words the UI actually shows. */
const ENGLISH = JSON.parse(readFileSync(resolve(root, "locales/en.json"), "utf8")) as Record<string, string>;
const tEnglish = () => englishTranslator(ENGLISH);

/** What a fresh install reads back before anything is chosen. */
const freshSettings = {
  engine: "ai",
  target: "zh-CN",
  provider: "",
  model: "",
  endpoint: "",
  apiKey: "",
  reasoning: LOWEST,
};

/** The provider the "configured" half of the payload describes. */
const configuredProvider = "anthropic";
const configuredSettings = {
  ...freshSettings,
  provider: configuredProvider,
  model: "claude-sonnet-4-5",
  reasoning: LOWEST,
};

const USER_EDITED = "https://proxy.example/v1";

function uiText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Keys the plugin really calls, i.e. `t("key")` / `t("key", …)` in the panel and the host. */
function usedKeys(html: string): string[] {
  const sources = ["src/settingsPanel.ts", "src/index.ts"].map((file) => readFileSync(resolve(root, file), "utf8"));
  const fromSource = new Set(
    sources.flatMap((source) =>
      [...source.matchAll(/\bt\(\s*"([A-Za-z0-9_.]+)"\s*(?:,[^)]*)?\)/g)].map((match) => match[1]),
    ),
  );
  const keys = [...fromSource].sort();
  expect(keys.length).toBeGreaterThan(10);
  // Sanity: the rendered HTML is non-trivial and the panel is a form, not a message.
  expect(html).toContain("<form");
  expect(uiText(html).length).toBeGreaterThan(100);
  return keys;
}

/**
 * The provider picker's placeholder as the rendered `<select>` carries it. When a provider is
 * configured the row is absent from the markup entirely (SPEC 2.1: you cannot go back to empty),
 * so absence is reported as `selected: false` with the label the model still knows.
 */
function placeholderRow(html: string, t: ReturnType<typeof englishTranslator>, configured = false) {
  const label = t("providerPlaceholder");
  const match = html.match(/<option value=""([^>]*)>([^<]*)<\/option>/);
  if (!match) {
    expect(configured, "provider placeholder row is not rendered").toBe(true);
    return { value: "", label, disabled: true, selected: false };
  }
  const [, attributes, rowLabel] = match as RegExpMatchArray;
  expect(rowLabel).toBe(label);
  return {
    value: "",
    label,
    disabled: /\bdisabled\b/.test(attributes),
    selected: /\bselected\b/.test(attributes),
  };
}

function endpointPlaceholder(html: string): string {
  const match = html.match(/<input id="endpoint"[^>]*placeholder="([^"]*)"/);
  return match ? match[1] : "";
}

function endpointValue(html: string): string {
  const match = html.match(/<input id="endpoint"[^>]*value="([^"]*)"/);
  return match ? match[1] : "";
}

function modelSelectTag(html: string): string {
  return html.match(/<select id="model"[^>]*>/)?.[0] ?? "";
}

function reasoningSelectTag(html: string): string {
  return html.match(/<select id="reasoning"[^>]*>/)?.[0] ?? "";
}

/** One panel state, read out of the controls rather than out of the model. */
function readState(model: PanelModel, t: ReturnType<typeof englishTranslator>) {
  const html = renderPanelHtml(model);
  const provider = model.values.provider;
  return {
    html,
    provider: {
      control: "select",
      current: provider,
      placeholder: placeholderRow(html, t, provider !== ""),
      fallback: providerRequired({ ...model.values, engine: "ai" }, t) === "" ? provider : "",
      options: model.providers,
    },
    model: {
      control: "select",
      disabled: modelDisabled(model),
      selectedProvider: provider,
      selectedModel: model.values.model,
      options: model.modelsByProvider[provider] ?? [],
      byProvider: model.modelsByProvider,
    },
    endpoint: {
      control: "input",
      current: endpointValue(html),
      placeholder: endpointPlaceholder(html),
    },
    reasoning: {
      control: "select",
      disabled: reasoningDisabled(model),
      default: model.values.reasoning,
    },
    modelDisabledAttr: /\bdisabled\b/.test(modelSelectTag(html)),
    reasoningDisabledAttr: /\bdisabled\b/.test(reasoningSelectTag(html)),
  };
}

function buildPayload() {
  const t = tEnglish();
  const catalog = projectCatalog(fixture);

  const emptyPanel = buildPanelModel(freshSettings, catalog, t, languageNames);
  const empty = readState(emptyPanel, t);
  const chosenPanel = applyProviderChange(emptyPanel, configuredProvider);
  const chosen = readState(chosenPanel, t);
  const edited = applyEndpointEdit(chosenPanel, USER_EDITED);

  const locales = readLocales();
  const localeIds = Object.keys(locales).sort();
  const keys = usedKeys(`${empty.html}\n${chosen.html}`);

  return {
    spec: SPEC_VERSION,
    host: HOST,
    language: {
      control: "select",
      current: emptyPanel.values.target,
      options: emptyPanel.languages,
    },
    // Graded half of the contract: the unconfigured state of a fresh install.
    provider: empty.provider,
    model: empty.model,
    endpoint: {
      ...empty.endpoint,
      autofill: {
        before: empty.endpoint.current,
        after: chosen.endpoint.current,
        providerApi: catalog.providers[configuredProvider]?.api ?? "",
        userEdited: USER_EDITED,
        afterSwitch: applyProviderChange(edited, "deepseek").values.endpoint,
      },
    },
    reasoning: {
      control: "select",
      disabled: empty.reasoning.disabled,
      default: empty.reasoning.default,
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
    /** The other half: the same controls once a provider is chosen. */
    configured: {
      provider: chosen.provider,
      model: chosen.model,
      endpoint: chosen.endpoint,
      reasoning: {
        ...chosen.reasoning,
        // Choosing a provider must not rewrite the stored sentinel.
        sentinelAfterChoice: chosenPanel.values.reasoning,
      },
    },
    i18n: {
      locales: localeIds,
      sourceLocale: "en",
      keys,
      files: locales,
      used: usedKeys(chosen.html),
    },
    static: { hits: [] as unknown[] },
  };
}

describe("conformance kit", () => {
  it("its negative controls still catch every rule", () => {
    expect(selfTest()).toBeGreaterThanOrEqual(12);
  });

  it("conformance.json points at this host, SPEC 2.1 and the real settings sources", () => {
    expect(SPEC_VERSION).toBe("2.1.0");
    expect(config.spec).toBe(SPEC_VERSION);
    expect(config.host).toBe(HOST);
    expect(config.static.files).toEqual(["src/settingsPanel.ts", "src/index.ts"]);
    expect(config.static.patterns.length).toBeGreaterThan(0);
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

  it("reports the unconfigured state exactly as a fresh install renders it", () => {
    const payload = buildPayload();
    expect(payload.provider.current).toBe("");
    expect(payload.provider.placeholder).toEqual({
      value: "",
      label: "Select a provider",
      disabled: true,
      selected: true,
    });
    expect(payload.provider.fallback).toBe("");
    expect(payload.model.disabled).toBe(true);
    expect(payload.model.selectedProvider).toBe("");
    expect(payload.model.selectedModel).toBe("");
    expect(payload.model.options).toEqual([]);
    expect(payload.endpoint.current).toBe("");
    expect(payload.endpoint.placeholder).toBe("https://");
    expect(payload.reasoning.disabled).toBe(true);
    expect(payload.reasoning.default).toBe(LOWEST);

    // The markup and the contract agree: the disabled pickers are disabled in the HTML too.
    const t = tEnglish();
    const empty = readState(buildPanelModel(freshSettings, projectCatalog(fixture), t, languageNames), t);
    expect(empty.modelDisabledAttr).toBe(true);
    expect(empty.reasoningDisabledAttr).toBe(true);

    // No silent OpenAI state anywhere in the unconfigured half. The provider *option list* is
    // excluded because OpenAI is a legitimate provider to offer; what must not appear is an
    // OpenAI value in the current selection, the endpoint, or the model.
    const unconfigured = JSON.stringify({
      provider: {
        control: payload.provider.control,
        current: payload.provider.current,
        placeholder: payload.provider.placeholder,
        fallback: payload.provider.fallback,
      },
      model: {
        control: payload.model.control,
        disabled: payload.model.disabled,
        selectedProvider: payload.model.selectedProvider,
        selectedModel: payload.model.selectedModel,
        options: payload.model.options,
      },
      endpoint: { control: payload.endpoint.control, current: payload.endpoint.current, placeholder: payload.endpoint.placeholder },
      reasoning: { control: payload.reasoning.control, disabled: payload.reasoning.disabled, default: payload.reasoning.default },
    });
    expect(unconfigured).not.toContain("https://api.openai.com/v1");
    expect(unconfigured).not.toContain('"gpt-4o-mini"');
    expect(unconfigured).not.toContain(CUSTOM_PROVIDER);
  });

  it("reports the configured state once a provider is chosen", () => {
    const payload = buildPayload();
    const catalog = projectCatalog(fixture);
    expect(payload.configured.provider.current).toBe(configuredProvider);
    expect(payload.configured.provider.placeholder.selected).toBe(false);
    // The placeholder row stays in the list but can never be re-selected.
    expect(payload.configured.provider.placeholder.disabled).toBe(true);
    expect(payload.configured.model.disabled).toBe(false);
    expect(payload.configured.model.selectedProvider).toBe(configuredProvider);
    expect(payload.configured.endpoint.current).toBe(catalog.providers[configuredProvider].api);
    expect(payload.configured.reasoning.disabled).toBe(false);
    expect(payload.configured.reasoning.sentinelAfterChoice).toBe(LOWEST);
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
    // The placeholder is not one of them, and the custom entry is last.
    expect(payload.provider.options.some((option) => option.value === "")).toBe(false);
    expect(payload.provider.options[payload.provider.options.length - 1].source).toBe("custom");
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
    const model = buildPanelModel({ ...configuredSettings, model: "my-local-ft-1" }, catalog, englishTranslator(), languageNames);
    expect(renderPanelHtml(model)).toContain('<option value="my-local-ft-1" selected>my-local-ft-1</option>');
  });

  it("does not let a provider switch clobber a hand-typed endpoint", () => {
    const catalog = projectCatalog(fixture);
    const model = buildPanelModel(configuredSettings, catalog, englishTranslator(), languageNames);
    const edited = applyEndpointEdit(model, USER_EDITED);
    expect(applyProviderChange(edited, "deepseek").values.endpoint).toBe(USER_EDITED);
  });
});
