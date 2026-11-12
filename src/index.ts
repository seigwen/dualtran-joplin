declare const joplin: any;

import {
  buildChatRequest,
  chunkText,
  describeFetchFailure,
  googleUrl,
  parseChatResponse,
  parseGoogleResponse,
} from "./translate";
import {
  CATALOG_URL,
  CUSTOM_MODEL,
  CUSTOM_PROVIDER,
  LOWEST,
  isCatalogCacheFresh,
  parseCatalogCache,
  projectCatalog,
  resolveReasoningDepth,
} from "./catalog";
import type { Catalog, CatalogCache } from "./catalog";
import { SOURCE_LOCALE, createTranslator, detectLocale } from "./i18n";
import type { Messages, Translator } from "./i18n";
import {
  applyProviderChange,
  buildPanelModel,
  mergeDraft,
  providerRequired,
  readPanelMessage,
  renderPanelHtml,
} from "./settingsPanel";
import type { PanelModel, PanelSettings } from "./settingsPanel";

/**
 * Joplin plugins run in the Electron renderer with Node integration, so a plain `fetch` is not
 * subject to CORS — unlike the browser extension and the Logseq sandbox. That means every
 * OpenAI-compatible provider works here, including a locally hosted Ollama.
 */

const SECTION = "dualtran";
const SETTING_KEYS = ["engine", "target", "provider", "model", "endpoint", "apiKey", "reasoning", "catalogCache"];

/** Assets injected by the build step (`scripts/build-assets.mjs`); the panel degrades without them. */
interface InjectedAssets {
  messages?: Record<string, Messages>;
  languages?: Record<string, string>;
  panelScript?: string;
}
const ASSETS = ((globalThis as { __DUALTRAN__?: InjectedAssets }).__DUALTRAN__ ?? {}) as InjectedAssets;

// ── i18n ────────────────────────────────────────────────────────────────────────────────────

const MESSAGES: Record<string, Messages> = ASSETS.messages ?? {};

/** `pt_BR` → `pt_BR`, or the language family when that variant is not shipped. */
function resolveLocaleFile(locale: string): string {
  if (MESSAGES[locale]) return locale;
  const base = locale.split("_")[0];
  return MESSAGES[base] ? base : SOURCE_LOCALE;
}

function translatorFor(locale?: string): Translator {
  const tag = locale ?? detectLocale();
  return createTranslator(MESSAGES[resolveLocaleFile(tag)], { fallback: MESSAGES[SOURCE_LOCALE] });
}

const languageNames: Record<string, string> = ASSETS.languages ?? {
  en: "English",
  "zh-CN": "Chinese (Simplified)",
  "zh-TW": "Chinese (Traditional)",
};

// ── settings + catalogue ────────────────────────────────────────────────────────────────────

async function readSettings(): Promise<PanelSettings> {
  const values = (await joplin.settings.values(SETTING_KEYS)) as Record<string, unknown>;
  const text = (key: string, fallback: string) => {
    const value = values[key];
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  };
  // SPEC 2.1: a fresh install has no AI provider. `""` is the unconfigured state — never a
  // provider, never an endpoint. Stored values are returned as they are.
  return {
    engine: text("engine", "google") === "ai" ? "ai" : "google",
    target: text("target", "zh-CN"),
    provider: text("provider", ""),
    model: text("model", ""),
    endpoint: text("endpoint", ""),
    apiKey: text("apiKey", ""),
    reasoning: text("reasoning", LOWEST),
    // An endpoint typed outside the panel is an override: a provider switch must not replace it.
    endpointCustom: text("endpoint", "") !== "",
  };
}

interface CatalogState {
  catalog: Catalog;
  fetchedAt: number | null;
  status: "fresh" | "stale" | "builtin";
}

let catalogState: CatalogState = { catalog: projectCatalog({}), fetchedAt: null, status: "builtin" };

function useCachedCatalog(cache: CatalogCache | null, status: CatalogState["status"]): boolean {
  if (!cache) return false;
  catalogState = { catalog: projectCatalog(cache.raw), fetchedAt: cache.fetchedAt, status };
  return true;
}

/**
 * Load models.dev. A 24h cache lives in `joplin.settings.catalogCache`; when a refresh fails the
 * stale cache is used, and with no cache at all the built-ins keep the panel usable offline.
 */
async function loadCatalog(options: { force?: boolean } = {}): Promise<CatalogState> {
  const values = (await joplin.settings.values(["catalogCache"])) as Record<string, unknown>;
  const cache = parseCatalogCache(typeof values.catalogCache === "string" ? values.catalogCache : null);

  if (!options.force && isCatalogCacheFresh(cache, Date.now()) && useCachedCatalog(cache, "fresh")) {
    return catalogState;
  }

  try {
    const response = await fetch(CATALOG_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const raw = await response.json();
    const next: CatalogCache = { fetchedAt: Date.now(), raw };
    await joplin.settings.setValue("catalogCache", JSON.stringify(next));
    catalogState = { catalog: projectCatalog(raw), fetchedAt: next.fetchedAt, status: "fresh" };
  } catch {
    if (!useCachedCatalog(cache, "stale")) {
      catalogState = { ...catalogState, status: catalogState.fetchedAt ? "stale" : "builtin" };
    }
  }
  return catalogState;
}

async function saveSettings(next: Partial<PanelSettings>): Promise<void> {
  const patch: Record<string, string> = {
    engine: next.engine === "ai" ? "ai" : "google",
    target: String(next.target || "zh-CN"),
    // SPEC 2.1: "" is a legitimate stored value (unconfigured). Saving it is a no-op for the
    // provider, never a rewrite into the custom entry — and an empty draft is already filtered
    // out by `mergeDraft`, so a configured provider cannot be cleared from the panel.
    provider: String(next.provider || ""),
    model: String(next.model || ""),
    endpoint: String(next.endpoint || ""),
    apiKey: String(next.apiKey || ""),
    reasoning: String(next.reasoning || LOWEST),
  };
  for (const [key, value] of Object.entries(patch)) await joplin.settings.setValue(key, value);
}

// ── engine call ─────────────────────────────────────────────────────────────────────────────

/**
 * SPEC 2.1 — the hard stop in front of every AI request. An AI install with no provider has no
 * endpoint, no model and no key; guessing one (OpenAI, or the last custom URL) would send the
 * user's text somewhere they never chose. Returns the localized message, or `""` when the
 * request may proceed. Google is unaffected: it needs no provider.
 */
function providerBlocked(config: PanelSettings, t: Translator): string {
  return providerRequired(config, t);
}

async function translateOne(text: string, config: PanelSettings): Promise<string> {
  const options = { text, target: config.target };

  if (config.engine === "google") {
    const url = googleUrl(options);
    let response: Response;
    try {
      response = await fetch(url);
    } catch (error) {
      throw new Error(describeFetchFailure(error, url));
    }
    if (!response.ok) throw new Error(`Google Translate answered HTTP ${response.status}`);
    return parseGoogleResponse(await response.json());
  }

  // SPEC 2.1 — no provider, no request. Checked before the URL is even built, so an empty
  // endpoint can never reach `normalizeEndpoint` and no fallback can sneak in behind it.
  const blocked = providerBlocked(config, translatorFor());
  if (blocked) throw new Error(blocked);

  const { url, init } = buildChatRequest(
    {
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      model: config.model,
      // `lowest` is stored as a request; the wire needs the concrete level this model declares.
      reasoning: resolveReasoningDepth(
        config.reasoning,
        catalogState.catalog.providers[config.provider]?.models.find((model) => model.id === config.model)?.efforts ?? [],
      ),
    },
    options,
  );
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new Error(describeFetchFailure(error, url));
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = (body as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(`AI endpoint answered HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return parseChatResponse(body);
}

async function translateText(text: string, config: PanelSettings): Promise<string> {
  const chunks = chunkText(text);
  const out: string[] = [];
  for (const chunk of chunks) out.push(await translateOne(chunk, config));
  return out.join("\n\n");
}

// ── commands ────────────────────────────────────────────────────────────────────────────────

/**
 * Read the settings and refuse early when the AI engine has no provider (SPEC 2.1). Returns the
 * config, or `null` after showing the localized `providerRequiredError` — the same string the
 * disabled command label carries as its tooltip.
 */
async function readSettingsForRequest(t: Translator): Promise<PanelSettings | null> {
  const config = await readSettings();
  const blocked = providerBlocked(config, t);
  if (!blocked) return config;
  await joplin.views.dialogs.showMessageBox(blocked);
  return null;
}

/** Translate the open note into a sibling note, leaving the source untouched. */
async function translateCurrentNote(): Promise<void> {
  const t = translatorFor();
  const note = await joplin.workspace.selectedNote();
  if (!note) {
    await joplin.views.dialogs.showMessageBox(t("msgOpenNoteFirst"));
    return;
  }
  const body = (note.body || "").trim();
  if (!body) {
    await joplin.views.dialogs.showMessageBox(t("msgEmptyNote"));
    return;
  }
  const config = await readSettingsForRequest(t);
  if (!config) return;
  try {
    const translated = await translateText(body, config);
    const parentId = note.parent_id;
    const folder = await joplin.data.get(["folders", parentId], { fields: ["id", "title"] });
    await joplin.data.post(["notes"], null, {
      parent_id: parentId,
      title: `${note.title || "Untitled"} · ${config.target}`,
      body: translated,
    });
    await joplin.views.dialogs.showMessageBox(t("msgTranslatedInto", { FOLDER: folder.title }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await joplin.views.dialogs.showMessageBox(t("msgTranslateFailed", { ERROR: message }));
  }
}

/** Translate the current selection and insert it below the selected paragraph. */
async function translateSelection(): Promise<void> {
  const t = translatorFor();
  const note = await joplin.workspace.selectedNote();
  if (!note) {
    await joplin.views.dialogs.showMessageBox(t("msgOpenNoteFirst"));
    return;
  }
  let selection = "";
  try {
    selection = String((await joplin.commands.execute("selectedText")) || "");
  } catch {
    selection = "";
  }
  if (!selection.trim()) {
    await joplin.views.dialogs.showMessageBox(t("msgSelectTextFirst"));
    return;
  }
  const config = await readSettingsForRequest(t);
  if (!config) return;
  try {
    const translated = await translateText(selection.trim(), config);
    const body = `${note.body || ""}`.replace(selection, `${selection}\n\n${translated}`);
    await joplin.data.put(["notes", note.id], null, { body });
    await joplin.commands.execute("editor.setText", body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await joplin.views.dialogs.showMessageBox(t("msgTranslateFailed", { ERROR: message }));
  }
}

// ── settings panel ──────────────────────────────────────────────────────────────────────────

let panelHandle: string | null = null;
/** The model as last rendered: a provider switch is resolved against it, not against settings. */
let panelModel: PanelModel | null = null;
let panelLocale = SOURCE_LOCALE;

/**
 * `panel.js` is a view script, not a bundled module: the build copies it to
 * `dist/dualtran-panel.js` and the plugin reads it back with Node fs. If the host cannot reach
 * it, the panel still renders and saves on click — only the reactive dropdowns are lost.
 */
function loadPanelScript(): string {
  if (typeof ASSETS.panelScript === "string" && ASSETS.panelScript.trim()) return ASSETS.panelScript;
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const candidate = path.join(__dirname, "dualtran-panel.js");
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf8");
  } catch {
    // No Node fs (rare) — fall through to a script-less panel.
  }
  return "";
}

async function ensurePanel(): Promise<string> {
  if (panelHandle) return panelHandle;
  const handle = await joplin.views.panels.create("dualtranSettingsPanel");
  const script = loadPanelScript();
  if (script) await joplin.views.panels.addScript(handle, "dualtran-panel.js");
  panelHandle = handle;
  return handle;
}

async function render(model: PanelModel, status = ""): Promise<void> {
  if (!panelHandle) return;
  panelModel = model;
  await joplin.views.panels.setHtml(panelHandle, renderPanelHtml(model, status));
}

async function openSettingsPanel(): Promise<void> {
  panelLocale = detectLocale();
  const t = translatorFor(panelLocale);
  const handle = await ensurePanel();
  const state = await loadCatalog();
  const model = buildPanelModel(await readSettings(), state.catalog, t, languageNames);
  const status = state.status === "builtin" ? t("statusRefreshFailed") : "";
  await render(model, status);
  await joplin.views.panels.show(handle, true);
}

/**
 * Every message is a save of the whole draft: the panel never decides. A provider change is
 * resolved against the previous render so the endpoint autofill (R3), the new model list (R2)
 * and the reasoning scale (R4) move together — unless the endpoint is the user's own.
 */
async function handlePanelMessage(message: unknown): Promise<boolean> {
  const received = readPanelMessage(message);
  if (!received) return false;

  const t = translatorFor(panelLocale);
  const current = await readSettings();

  if (received.action === "refresh") {
    const state = await loadCatalog({ force: true });
    const rebuilt = buildPanelModel(current, state.catalog, t, languageNames);
    const status =
      state.status === "builtin"
        ? t("statusRefreshFailed")
        : t("statusRefreshed", { COUNT: Object.keys(state.catalog.providers).length });
    await render(rebuilt, status);
    return true;
  }

  const draft = received.draft;
  const next = mergeDraft(current, draft);

  if (panelModel && draft?.provider && draft.provider !== panelModel.values.provider) {
    const applied = applyProviderChange(
      {
        ...panelModel,
        values: {
          ...panelModel.values,
          endpoint: typeof draft.endpoint === "string" ? draft.endpoint : panelModel.values.endpoint,
          endpointCustom: next.endpointCustom === true,
        },
      },
      draft.provider,
    );
    next.provider = applied.values.provider;
    next.model =
      draft.model === CUSTOM_MODEL && draft.customModel ? String(draft.customModel).trim() : applied.values.model;
    next.endpoint = applied.values.endpoint;
    next.endpointCustom = applied.values.endpointCustom;
    next.reasoning = applied.values.reasoning;
  }

  await saveSettings(next);
  const rebuilt = buildPanelModel(next, catalogState.catalog, t, languageNames);
  await render(rebuilt, t("statusSaved"));
  return true;
}

joplin.plugins.register({
  onStart: async () => {
    const t = translatorFor();

    await joplin.settings.registerSection(SECTION, {
      label: "DualTran",
      iconName: "fas fa-language",
    });
    // The panel is the primary UI. These stay as a fallback for anyone who cannot open it, and
    // as an escape hatch for values the catalogue does not know (a proxy, a fine-tuned model).
    await joplin.settings.registerSettings({
      engine: {
        value: "google",
        type: 2,
        isEnum: true,
        section: SECTION,
        public: true,
        label: t("settingsEngineLabel"),
        description: t("settingsEngineDescription"),
        options: { google: t("engineGoogle"), ai: t("engineAi") },
      },
      target: {
        value: "zh-CN",
        type: 2,
        section: SECTION,
        public: true,
        label: t("settingsTargetLabel"),
        description: t("settingsTargetDescription"),
      },
      provider: {
        // SPEC 2.1: a fresh install has no provider. `""` renders as the disabled placeholder in
        // the panel; the custom endpoint stays available as the last optional entry, not a default.
        value: "",
        type: 2,
        section: SECTION,
        public: true,
        label: t("settingsProviderLabel"),
        description: t("settingsProviderDescription"),
      },
      model: {
        value: "",
        type: 2,
        section: SECTION,
        public: true,
        label: t("settingsModelLabel"),
        description: t("settingsModelDescription"),
      },
      endpoint: {
        value: "",
        type: 2,
        section: SECTION,
        public: true,
        label: t("settingsEndpointLabel"),
        description: t("settingsEndpointDescription"),
      },
      apiKey: {
        value: "",
        type: 2,
        section: SECTION,
        public: true,
        label: t("settingsApiKeyLabel"),
        description: t("settingsApiKeyDescription"),
      },
      reasoning: {
        value: LOWEST,
        type: 2,
        section: SECTION,
        public: true,
        label: t("settingsReasoningLabel"),
        description: t("settingsReasoningDescription"),
      },
      catalogCache: {
        value: "",
        type: 2,
        section: SECTION,
        public: false,
        label: "Catalogue cache (advanced)",
        description: "Internal: the models.dev catalogue, cached for 24 hours. Clear it to force a refresh.",
      },
    });

    // SPEC 2.1 — where a primary button exists, it is disabled while no provider is configured
    // and carries the same localized string as its tooltip. A menu entry has no disabled state,
    // so its label keeps its name and the command itself refuses with `providerRequiredError`.
    const initialBlocked = providerBlocked(await readSettings(), t);
    const commandState = (enabled: boolean) =>
      enabled
        ? {}
        : { enabled: false, disabled: true, title: initialBlocked, tooltip: initialBlocked };

    await joplin.commands.register({
      name: "dualtranOpenSettings",
      label: t("commandOpenSettings"),
      iconName: "fas fa-sliders-h",
      execute: openSettingsPanel,
    });
    await joplin.commands.register({
      name: "dualtranTranslateNote",
      label: t("commandTranslateNote"),
      iconName: "fas fa-language",
      execute: translateCurrentNote,
      ...commandState(initialBlocked === ""),
    });
    await joplin.commands.register({
      name: "dualtranTranslateSelection",
      label: t("commandTranslateSelection"),
      iconName: "fas fa-align-left",
      execute: translateSelection,
      ...commandState(initialBlocked === ""),
    });
    await joplin.views.menuItems.create("dualtranMenuSettings", "dualtranOpenSettings", "tools");
    await joplin.views.menuItems.create("dualtranMenuNote", "dualtranTranslateNote", "tools");
    await joplin.views.menuItems.create("dualtranMenuSel", "dualtranTranslateSelection", "tools");

    // Create the panel and attach the handler at start: `onMessage` needs a live handle, and the
    // catalogue fetch then happens in the background instead of on the first open.
    const handle = await ensurePanel();
    await joplin.views.panels.onMessage(handle, handlePanelMessage);
    await loadCatalog();
  },
});
