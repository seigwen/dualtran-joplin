import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CUSTOM_MODEL, CUSTOM_PROVIDER, LOWEST, projectCatalog } from "../src/catalog";
import { createTranslator } from "../src/i18n";
import {
  applyEndpointEdit,
  applyModelChange,
  applyProviderChange,
  applyReasoningChange,
  buildPanelModel,
  mergeDraft,
  readPanelMessage,
  renderPanelHtml,
} from "../src/settingsPanel";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sample = JSON.parse(readFileSync(resolve(root, "tests/fixtures/conformance/models-dev-sample.json"), "utf8")) as unknown;
const languageNames = JSON.parse(readFileSync(resolve(root, "tests/fixtures/conformance/language-names.json"), "utf8")) as Record<
  string,
  string
>;
const en = JSON.parse(readFileSync(resolve(root, "locales/en.json"), "utf8")) as Record<string, string>;

const t = createTranslator(en);
const catalog = projectCatalog(sample);
const settings = {
  engine: "ai",
  target: "zh-CN",
  provider: "openai",
  model: "gpt-5.6-luna",
  endpoint: "https://api.openai.com/v1",
  apiKey: "k",
  reasoning: LOWEST,
};

function model(overrides: Partial<typeof settings> = {}) {
  return buildPanelModel({ ...settings, ...overrides }, catalog, t, languageNames);
}

describe("buildPanelModel", () => {
  it("exposes the four pickers and the values they render", () => {
    const panel = model();
    expect(panel.languages.length).toBeGreaterThanOrEqual(30);
    expect(panel.providers.length).toBeGreaterThan(5);
    expect(panel.modelsByProvider.openai.length).toBeGreaterThan(1);
    expect(panel.reasoningOptions[0].value).toBe(LOWEST);
    expect(panel.values).toMatchObject({ target: "zh-CN", provider: "openai", model: "gpt-5.6-luna" });
  });

  it("builds a model list for every provider, custom last, catalogue alphabetical", () => {
    const panel = model();
    const providerIds = panel.providers.map((option) => option.value);
    expect(Object.keys(panel.modelsByProvider).sort()).toEqual([...providerIds].sort());
    expect(panel.providers[panel.providers.length - 1].value).toBe(CUSTOM_PROVIDER);
    for (const [providerId, rows] of Object.entries(panel.modelsByProvider)) {
      expect(rows[rows.length - 1].value, providerId).toBe(CUSTOM_MODEL);
    }
  });

  it("keeps an unknown configured model selectable", () => {
    const panel = model({ model: "my-ft-1" });
    const rendered = renderPanelHtml(panel);
    expect(rendered).toContain('<option value="my-ft-1" selected>my-ft-1</option>');
  });

  it("falls back to the custom provider rather than an empty picker", () => {
    const panel = model({ provider: "" });
    expect(panel.values.provider).toBe(CUSTOM_PROVIDER);
    expect(panel.modelsByProvider[CUSTOM_PROVIDER].length).toBeGreaterThan(0);
  });

  it("resolves the lowest sentinel against the selected model", () => {
    expect(model({ model: "gpt-5.6-luna", reasoning: LOWEST }).reasoningResolved).toBe("none");
    expect(model({ model: "gpt-4o", reasoning: LOWEST }).reasoningResolved).toBe("");
  });

  it("offers only the levels the model declares, plus the sentinel", () => {
    const panel = model({ model: "gpt-5.4-mini" });
    expect(panel.reasoningOptions.map((option) => option.value)).toEqual([LOWEST, "none", "low", "medium", "high", "xhigh"]);
  });
});

describe("applyProviderChange (R3 + R2)", () => {
  it("fills the endpoint and reselects a model from the new provider", () => {
    const next = applyProviderChange(model(), "deepseek");
    expect(next.values.provider).toBe("deepseek");
    expect(next.values.endpoint).toBe("https://api.deepseek.com");
    expect(next.modelsByProvider.deepseek.some((option) => option.value === next.values.model)).toBe(true);
  });

  it("keeps a user's endpoint override", () => {
    const edited = applyEndpointEdit(model(), "https://proxy.example/v1");
    expect(applyProviderChange(edited, "deepseek").values.endpoint).toBe("https://proxy.example/v1");
  });

  it("re-derives the reasoning scale for the new model", () => {
    const next = applyProviderChange(model({ model: "gpt-5.6-luna" }), "anthropic");
    const offered = next.reasoningOptions.map((option) => option.value);
    expect(offered.length).toBeGreaterThan(1);
    expect(offered).toContain(next.reasoningResolved);
  });

  it("returns a new model instead of mutating", () => {
    const before = model();
    const snapshot = JSON.stringify(before.values);
    applyProviderChange(before, "groq");
    expect(JSON.stringify(before.values)).toBe(snapshot);
  });

  it("switching to the custom provider keeps the endpoint editable and empty-able", () => {
    const next = applyProviderChange(model(), CUSTOM_PROVIDER);
    expect(next.values.provider).toBe(CUSTOM_PROVIDER);
    expect(next.modelsByProvider[CUSTOM_PROVIDER].map((option) => option.value)).toEqual([CUSTOM_MODEL]);
  });
});

describe("model and reasoning changes", () => {
  it("typing in the endpoint marks it custom", () => {
    expect(applyEndpointEdit(model(), "https://x.example/v1").values.endpointCustom).toBe(true);
  });

  it("changing the model re-scopes the reasoning options", () => {
    const next = applyModelChange(model(), "gpt-4o");
    expect(next.reasoningOptions.map((option) => option.value)).toEqual([LOWEST]);
    expect(next.reasoningResolved).toBe("");
  });

  it("an explicit level survives a model change", () => {
    const next = applyModelChange(model({ reasoning: "high" }), "gpt-5.4-mini");
    expect(next.values.reasoning).toBe("high");
  });

  it("sets reasoning verbatim", () => {
    expect(applyReasoningChange(model(), "medium").values.reasoning).toBe("medium");
    expect(applyReasoningChange(model(), "").values.reasoning).toBe(LOWEST);
  });
});

describe("panel messages", () => {
  it("accepts save and refresh, rejects anything else", () => {
    expect(readPanelMessage({ action: "save" })?.action).toBe("save");
    expect(readPanelMessage({ action: "refresh" })?.action).toBe("refresh");
    expect(readPanelMessage({ action: "delete" })).toBeNull();
    expect(readPanelMessage(null)).toBeNull();
    expect(readPanelMessage("save")).toBeNull();
  });

  it("merges a draft over the current settings", () => {
    const merged = mergeDraft(settings, { language: "ja", model: "__custom__", customModel: "my-ft-2", provider: "groq" });
    expect(merged).toMatchObject({ target: "ja", model: "my-ft-2", provider: "groq", engine: "ai" });
  });

  it("keeps the previous model when the custom box is empty", () => {
    // Choosing "Custom model…" and saving nothing must not wipe the configured model.
    const merged = mergeDraft(settings, { model: CUSTOM_MODEL, customModel: "   " });
    expect(merged.model).toBe(settings.model);
  });

  it("carries the endpoint override flag from the draft", () => {
    expect(mergeDraft(settings, { endpoint: "https://proxy/v1", endpointCustom: true }).endpointCustom).toBe(true);
    expect(mergeDraft(settings, { endpoint: "https://proxy/v1", endpointCustom: false }).endpointCustom).toBe(false);
  });

  it("ignores unknown draft keys and non-string values", () => {
    const merged = mergeDraft(settings, { target: 42, evil: "x" } as never);
    expect(merged.target).toBe("zh-CN");
    expect((merged as Record<string, unknown>).evil).toBeUndefined();
  });
});

describe("renderPanelHtml", () => {
  const html = renderPanelHtml(model());

  it("renders every control the panel needs", () => {
    expect(html).toContain('<select id="target">');
    expect(html).toContain('<select id="provider">');
    expect(html).toContain('<select id="model">');
    expect(html).toContain('<input id="endpoint"');
    expect(html).toContain('<select id="reasoning">');
    expect(html).toContain('<input id="apiKey" type="password"');
  });

  it("offers Save and Refresh", () => {
    expect(html).toContain('id="save"');
    expect(html).toContain('id="refresh"');
  });

  it("marks the selected option and the current endpoint", () => {
    expect(html).toMatch(/<option value="openai" selected>OpenAI<\/option>/);
    expect(html).toContain('value="https://api.openai.com/v1"');
  });

  it("shows the reasoning sentinel with its resolution", () => {
    expect(html).toMatch(/<option value="lowest" selected>Lowest available \(none\)<\/option>/);
  });

  it("escapes values instead of injecting them", () => {
    const panel = buildPanelModel(
      { ...settings, model: '<script>alert(1)</script>' },
      catalog,
      t,
      languageNames,
    );
    const rendered = renderPanelHtml(panel);
    expect(rendered).not.toContain("<script>alert(1)</script>");
    expect(rendered).toContain("&lt;script&gt;");
  });

  it("puts the custom model box last and hidden unless needed", () => {
    const rendered = renderPanelHtml(model({ model: "not-in-catalogue" }));
    // The unknown model stays selected, the custom action stays last, and the box shows its id.
    expect(rendered).toContain('<option value="not-in-catalogue" selected>not-in-catalogue</option>');
    expect(rendered).toMatch(/<option value="__custom__">[^<]*<\/option><\/select>/);
    expect(rendered).toContain('<input id="customModel" type="text" placeholder="Model id, e.g. gpt-4o-mini" value="not-in-catalogue">');
    expect(html).toContain('<input id="customModel" type="text" placeholder="Model id, e.g. gpt-4o-mini" value="" hidden>');
  });

  it("carries the status text, escaped", () => {
    expect(renderPanelHtml(model(), "Saved.")).toContain(">Saved.<");
    expect(renderPanelHtml(model(), '<b>x</b>')).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});
