/**
 * SPEC 2.1 — the unconfigured state (T10).
 *
 * A fresh install has no AI provider: `provider === ""`, not "openai" and not the custom
 * endpoint. This file pins the empty state at every layer that can decide it — the panel model,
 * the rendered HTML, and the request path (zero fetch, localized error) — plus the rule that a
 * stored value is never rewritten into something else.
 *
 * The end-to-end half runs the built `dist/index.js` against a fake Joplin host, so the wiring
 * is verified and not only the pure helpers.
 *
 * RED state: these fail until the empty-provider branch exists (the model falls back to the
 * custom provider, the endpoint falls back to OpenAI, and the request is sent anyway).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { CUSTOM_PROVIDER, LOWEST, projectCatalog } from "../src/catalog";
import { createTranslator } from "../src/i18n";
import type { Messages } from "../src/i18n";
import {
  applyEndpointEdit,
  applyProviderChange,
  buildPanelModel,
  mergeDraft,
  providerRequired,
  reasoningDisabled,
  renderPanelHtml,
} from "../src/settingsPanel";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sample = JSON.parse(readFileSync(resolve(root, "tests/fixtures/conformance/models-dev-sample.json"), "utf8")) as unknown;
const languageNames = JSON.parse(readFileSync(resolve(root, "tests/fixtures/conformance/language-names.json"), "utf8")) as Record<
  string,
  string
>;
const en = JSON.parse(readFileSync(resolve(root, "locales/en.json"), "utf8")) as Messages;
const zh = JSON.parse(readFileSync(resolve(root, "locales/zh_CN.json"), "utf8")) as Messages;

const t = createTranslator(en);
const catalog = projectCatalog(sample);

/** Exactly what a fresh install reads back: no provider, no endpoint, no model, no key. */
const EMPTY = {
  engine: "ai",
  target: "zh-CN",
  provider: "",
  model: "",
  endpoint: "",
  apiKey: "",
  reasoning: LOWEST,
};

const settings = {
  ...EMPTY,
  provider: "openai",
  model: "gpt-5.6-luna",
  endpoint: "https://api.openai.com/v1",
};

const empty = () => buildPanelModel(EMPTY, catalog, t, languageNames);

describe("empty provider — panel model", () => {
  it("keeps the provider empty instead of falling back to the custom endpoint", () => {
    expect(empty().values.provider).toBe("");
  });

  it("keeps the endpoint empty, with no OpenAI default", () => {
    const panel = empty();
    expect(panel.values.endpoint).toBe("");
    const html = renderPanelHtmlOf(panel);
    expect(html).not.toContain("https://api.openai.com/v1");
  });

  it("keeps the reasoning sentinel stored even though the picker is inert", () => {
    const panel = empty();
    expect(panel.values.reasoning).toBe(LOWEST);
    expect(reasoningDisabled(panel)).toBe(true);
  });

  it("still offers every real provider, custom last — the placeholder is not an option", () => {
    const panel = empty();
    expect(panel.providers.length).toBeGreaterThan(5);
    expect(panel.providers[panel.providers.length - 1].value).toBe(CUSTOM_PROVIDER);
    expect(panel.providers.some((option) => option.value === "")).toBe(false);
  });
});

describe("empty provider — rendered controls", () => {
  it("renders the placeholder as a disabled, selected, empty-valued row", () => {
    const html = renderPanelHtmlOf(empty());
    expect(html).toContain('<option value="" disabled selected>Select a provider</option>');
    // …and no real provider is selected: the empty state is not custom.
    expect(html).not.toMatch(/<option value="openai" selected>/);
    expect(html).not.toMatch(/<option value="[^"]+" selected>[^<]*Custom endpoint/);
  });

  it("disables the model picker and labels it 'Select a provider first'", () => {
    const html = renderPanelHtmlOf(empty());
    // A `<select>` whose only row is the label: disabled, and nothing to pick.
    expect(html).toMatch(/<select id="model" disabled aria-disabled="true">\s*<option value="" selected disabled>Select a provider first<\/option>\s*<\/select>/);
  });

  it("disables the reasoning picker but keeps its sentinel selected", () => {
    const html = renderPanelHtmlOf(empty());
    expect(html).toContain('<select id="reasoning" disabled aria-disabled="true">');
    expect(html).toMatch(/<option value="lowest" selected>/);
  });

  it("gives the endpoint an empty value and the bare https:// placeholder", () => {
    const html = renderPanelHtmlOf(empty());
    expect(html).toContain('<input id="endpoint" type="text" data-custom="false" placeholder="https://" value="">');
  });

  it("localizes the placeholder strings", () => {
    const panel = buildPanelModel(EMPTY, catalog, createTranslator(zh, { fallback: en }), languageNames);
    const html = renderPanelHtmlOf(panel);
    expect(html).toContain('<option value="" disabled selected>请选择 AI 提供商</option>');
    expect(html).toContain('<option value="" selected disabled>请先选择提供商</option>');
  });
});

describe("choosing a provider from empty", () => {
  it("fills the endpoint value, loads the models and enables reasoning", () => {
    const next = applyProviderChange(empty(), "anthropic");
    expect(next.values.provider).toBe("anthropic");
    expect(next.values.endpoint).not.toBe("");
    expect(next.values.endpoint).toBe(catalog.providers.anthropic.api);
    expect(next.values.model).not.toBe("");
    expect(reasoningDisabled(next)).toBe(false);
    expect(renderPanelHtmlOf(next)).toContain(`value="${next.values.endpoint}"`);
  });

  it("cannot go back to the empty state, and offers no 'None' row", () => {
    const next = applyProviderChange(empty(), "anthropic");
    // The placeholder only exists as a `<select>` row; an empty provider is not an option.
    expect(next.providers.some((option) => option.value === "" || /^none$/i.test(option.label))).toBe(false);
    const back = applyProviderChange(next, "");
    expect(back.values.provider).toBe("anthropic");
    expect(renderPanelHtmlOf(back)).not.toMatch(/<option value=""[^>]*selected/);
  });

  it("does not clobber a hand-edited endpoint when the provider changes later", () => {
    const chosen = applyProviderChange(empty(), "anthropic");
    const edited = applyEndpointEdit(chosen, "https://proxy.example/v1");
    expect(applyProviderChange(edited, "deepseek").values.endpoint).toBe("https://proxy.example/v1");
  });
});

describe("stored values are never rewritten", () => {
  it("keeps the configured provider when the picker still shows the placeholder", () => {
    // A provider picker whose value is still the placeholder posts `provider: ""`; the stored
    // provider must survive that save instead of being reset.
    const merged = mergeDraft({ ...settings }, { provider: "" });
    expect(merged.provider).toBe("openai");
  });

  it("does not invent a provider out of an empty draft", () => {
    const merged = mergeDraft({ ...EMPTY }, { provider: "", model: "", endpoint: "" });
    expect(merged.provider).toBe("");
  });

  it("reports the localized error when no provider is configured", () => {
    expect(providerRequired(EMPTY, t)).toBe(en.providerRequiredError);
    expect(providerRequired(EMPTY, createTranslator(zh, { fallback: en }))).toBe(zh.providerRequiredError);
    expect(providerRequired(settings, t)).toBe("");
    // The Google engine needs no AI provider at all.
    expect(providerRequired({ ...EMPTY, engine: "google" }, t)).toBe("");
  });
});

// ── request path ────────────────────────────────────────────────────────────────────────────

const bundlePath = resolve(root, "dist/index.js");
const skip = !existsSync(bundlePath);

interface FakeHost {
  settings: Record<string, unknown>;
  fetches: string[];
  dialogs: string[];
  html: string[];
  commands: Map<string, () => Promise<unknown>>;
  handlers: Array<(message: unknown) => Promise<unknown>>;
  written: unknown[];
  onStart: (() => Promise<void>) | null;
}

function boot(overrides: Record<string, unknown> = {}): FakeHost {
  const host: FakeHost = {
    settings: {
      engine: "ai",
      target: "zh-CN",
      provider: "",
      model: "",
      endpoint: "",
      apiKey: "",
      reasoning: "lowest",
      ...overrides,
    },
    fetches: [],
    dialogs: [],
    html: [],
    commands: new Map(),
    handlers: [],
    written: [],
    onStart: null,
  };

  const joplin = {
    plugins: {
      register: (definition: { onStart: () => Promise<void> }) => {
        host.onStart = definition.onStart;
      },
    },
    settings: {
      registerSection: async () => undefined,
      registerSettings: async () => undefined,
      values: async (keys: string[]) => Object.fromEntries(keys.map((key) => [key, host.settings[key]])),
      setValue: async (key: string, value: unknown) => {
        host.settings[key] = value;
      },
    },
    commands: {
      register: (command: { name: string; execute: () => Promise<unknown> }) => {
        host.commands.set(command.name, command.execute);
      },
      execute: async () => "the quick brown fox",
    },
    workspace: {
      selectedNote: async () => ({ id: "n1", title: "Note", body: "the quick brown fox", parent_id: "f1" }),
    },
    views: {
      dialogs: {
        showMessageBox: async (message: string) => {
          host.dialogs.push(message);
          return 0;
        },
      },
      menuItems: { create: async () => undefined },
      panels: {
        create: async () => "panel-1",
        addScript: async () => undefined,
        setHtml: async (_handle: string, html: string) => {
          host.html.push(html);
        },
        onMessage: async (_handle: string, handler: (message: unknown) => Promise<unknown>) => {
          host.handlers.push(handler);
        },
        show: async () => undefined,
      },
    },
    data: {
      get: async () => ({ id: "f1", title: "Inbox" }),
      post: async (...args: unknown[]) => {
        host.written.push(args);
        return { id: "n2" };
      },
      put: async () => ({ id: "n1" }),
    },
  };

  const sandbox: Record<string, unknown> = {
    joplin,
    // The catalogue call is the only network call allowed; nothing must hit a provider.
    fetch: async (url: string) => {
      host.fetches.push(String(url));
      return { ok: false, status: 503, json: async () => ({}) };
    },
    console,
    setTimeout,
    clearTimeout,
  };
  runInContext(readFileSync(bundlePath, "utf8"), createContext(sandbox));
  return host;
}

describe.skipIf(skip)("empty provider — built plugin sends no request", () => {
  it("refuses to translate a note and says why, without any provider request", async () => {
    const host = boot();
    await host.onStart?.();
    await host.commands.get("dualtranTranslateNote")?.();

    expect(host.dialogs).toEqual([en.providerRequiredError]);
    expect(host.fetches.filter((url) => !url.includes("models.dev"))).toEqual([]);
    expect(host.written).toEqual([]);
  });

  it("refuses to translate a selection as well", async () => {
    const host = boot();
    await host.onStart?.();
    await host.commands.get("dualtranTranslateSelection")?.();

    expect(host.dialogs).toEqual([en.providerRequiredError]);
    expect(host.fetches.filter((url) => !url.includes("models.dev"))).toEqual([]);
  });

  it("posts the error dialog in the plugin locale", async () => {
    const host = boot({ provider: "" });
    await host.onStart?.();
    // `detectLocale()` reads Intl; the zh table is only reachable through the injected assets,
    // so this asserts the English source stays the fallback the user sees.
    expect(host.dialogs).toEqual([]);
    await host.commands.get("dualtranTranslateNote")?.();
    expect(host.dialogs[0]).toMatch(/Choose an AI provider in settings before translating\./);
  });

  it("renders the unconfigured panel from the real settings", async () => {
    const host = boot();
    await host.onStart?.();
    await host.commands.get("dualtranOpenSettings")?.();
    const html = host.html[host.html.length - 1] ?? "";
    expect(html).toContain('<option value="" disabled selected>Select a provider</option>');
    expect(html).toContain('<select id="model" disabled');
    expect(html).toContain('placeholder="https://"');
    expect(html).not.toContain("https://api.openai.com/v1");
  });

  it("still translates with Google, which needs no AI provider", async () => {
    const host = boot({ engine: "google" });
    // Google answer shape: [[["你好", "hello"]], null, "en"].
    const sandboxHost = host;
    await sandboxHost.onStart?.();
    await sandboxHost.commands.get("dualtranTranslateNote")?.();
    // Offline stub answers 503, so the call is attempted and fails with an HTTP error — the
    // point is that Google is not blocked by the provider guard.
    expect(sandboxHost.dialogs[0] ?? "").not.toBe(en.providerRequiredError);
  });
});

/** Thin alias so the assertions above read as "the panel HTML", not a function call. */
function renderPanelHtmlOf(panel: ReturnType<typeof buildPanelModel>): string {
  return renderPanelHtml(panel);
}
