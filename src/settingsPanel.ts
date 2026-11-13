/**
 * Settings panel — a pure model plus a string renderer, no Joplin API.
 *
 * Joplin's `joplin.settings` renders text fields and one flat enum; it cannot express "the model
 * list depends on the provider", cannot refresh a catalogue, and cannot show a password field.
 * So the panel is HTML in a Joplin view, and everything it decides lives here where it is
 * unit-testable without an Electron host.
 *
 * SPEC 2.1: a fresh install has no AI provider. `provider === ""` is the unconfigured state, not
 * a provider with a default — the picker shows a disabled placeholder, the model and reasoning
 * pickers are inert, and the endpoint is empty. Nothing falls back to OpenAI or to the custom
 * endpoint on its own.
 */
import {
  CUSTOM_MODEL,
  CUSTOM_PROVIDER,
  LOWEST,
  buildProviderList,
  languageOptions,
  modelsForProvider,
  resolveEndpointOnProviderChange,
  resolveReasoningDepth,
  reasoningOptions,
} from "./catalog";
import type { Catalog, ModelOption, ProviderOption } from "./catalog";
import type { Translator } from "./i18n";

export interface PanelSettings {
  engine: string;
  target: string;
  provider: string;
  model: string;
  endpoint: string;
  apiKey: string;
  reasoning: string;
  /** Set once the user edits the endpoint field; switching provider then leaves it alone (R3). */
  endpointCustom?: boolean;
}

export type PanelValues = Required<Omit<PanelSettings, "endpointCustom">> & { endpointCustom: boolean };

export interface PanelModel {
  languages: ModelOption[];
  providers: ProviderOption[];
  modelsByProvider: Record<string, ModelOption[]>;
  reasoningOptions: ModelOption[];
  /** What `lowest` resolves to for the selected model right now, for the sentinel label (R4). */
  reasoningResolved: string;
  values: PanelValues;
  /** Kept so provider/model changes can re-derive endpoints and reasoning scales. */
  catalog: Catalog;
  t: Translator;
  languageNames: Record<string, string>;
}

export interface PanelDraft {
  language?: string;
  provider?: string;
  model?: string;
  customModel?: string;
  endpoint?: string;
  apiKey?: string;
  reasoning?: string;
  endpointCustom?: boolean;
}

/** Shipped fallback: the panel still works if the language fixture is missing. */
export const DEFAULT_LANGUAGES: Record<string, string> = {
  en: "English",
  "zh-CN": "Chinese (Simplified)",
  "zh-TW": "Chinese (Traditional)",
  ja: "Japanese",
};

/** Placeholder shown in the endpoint field while no provider is chosen (SPEC 2.1). */
export const ENDPOINT_PLACEHOLDER = "https://";

/**
 * SPEC 2.1 — no provider selected. Read off the value rather than off a separate "configured"
 * flag: the stored `""` is the whole state, so a config saved by an older version keeps working.
 */
export function isUnconfigured(model: Pick<PanelModel, "values"> | { provider?: string }): boolean {
  const provider = "values" in model ? model.values.provider : model.provider;
  return String(provider ?? "").trim() === "";
}

/** SPEC 2.1 — the model picker is inert until a provider exists. */
export function modelDisabled(model: Pick<PanelModel, "values"> | { provider?: string }): boolean {
  return isUnconfigured(model);
}

/**
 * SPEC 2.1 — the reasoning picker is inert until a provider exists. The *stored* value stays the
 * sentinel; only the control is disabled, so configuring a provider later does not lose it.
 */
export function reasoningDisabled(model: Pick<PanelModel, "values"> | { provider?: string }): boolean {
  return isUnconfigured(model);
}

/**
 * SPEC 2.1 — the error a translation entry refuses with when the AI engine has no provider.
 * Returns `""` when the request may proceed: Google needs no provider, and a configured AI
 * install has one. Callers use the non-empty string both as the failure message and as the
 * primary button's tooltip, so the two can never disagree.
 */
export function providerRequired(
  settings: Pick<PanelSettings, "engine" | "provider">,
  t: Translator,
): string {
  if (settings.engine === "google") return "";
  return String(settings.provider ?? "").trim() === "" ? t("providerRequiredError") : "";
}

function effortsFor(catalog: Catalog, providerId: string, modelId: string): string[] {
  return catalog.providers[providerId]?.models.find((model) => model.id === modelId)?.efforts ?? [];
}

/**
 * R2 — one alphabetical list. The custom endpoint row is the only non-catalogue entry and sits
 * last, because it is an action ("none of these"), not a provider name. An empty provider is
 * *not* in this list: it is the picker's placeholder, rendered separately.
 */
function providersFor(catalog: Catalog, t: Translator): ProviderOption[] {
  return [
    ...buildProviderList(catalog),
    { value: CUSTOM_PROVIDER, label: t("customProviderLabel"), source: "custom", api: "" },
  ];
}

/** R2 — models for one provider, with the free-text row last. */
function modelsWithCustom(catalog: Catalog, providerId: string, t: Translator): ModelOption[] {
  const custom: ModelOption = { value: CUSTOM_MODEL, label: t("customModelLabel") };
  if (providerId === CUSTOM_PROVIDER) return [custom];
  // A model the catalogue does not list is appended by the renderer (`optionsHtml`) and shows in
  // the custom box, so it is never confused with a catalogue row the validator would sort.
  return [...modelsForProvider(catalog, providerId), custom];
}

/**
 * `settings`, `catalog`, `t` → everything the panel needs. `languages` is the full names table
 * (`language-names.json`); the small built-in set keeps the panel usable without it.
 *
 * A stored provider is kept verbatim (SPEC 2.1: stored values are never rewritten) — an id the
 * catalogue no longer lists still renders as the selected row instead of silently becoming the
 * custom endpoint.
 */
export function buildPanelModel(
  settings: Partial<PanelSettings>,
  catalog: Catalog,
  t: Translator,
  languages: Record<string, string> = DEFAULT_LANGUAGES,
): PanelModel {
  const engine = settings.engine === "google" ? "google" : "ai";
  const target = (settings.target || "zh-CN").trim();
  const provider = (settings.provider || "").trim();
  const model = (settings.model || "").trim();
  const endpoint = (settings.endpoint || "").trim();
  const reasoning = (settings.reasoning || LOWEST).trim() || LOWEST;

  const providers = providersFor(catalog, t);
  const modelsByProvider: Record<string, ModelOption[]> = {};
  for (const option of providers) {
    modelsByProvider[option.value] = modelsWithCustom(catalog, option.value, t);
  }

  const efforts = effortsFor(catalog, provider, model);
  const values: PanelValues = {
    engine,
    target,
    provider,
    model,
    endpoint,
    apiKey: String(settings.apiKey || ""),
    reasoning,
    endpointCustom: settings.endpointCustom === true,
  };

  return {
    languages: languageOptions(languages, target),
    providers,
    modelsByProvider,
    reasoningOptions: reasoningOptions(reasoning, efforts),
    reasoningResolved: resolveReasoningDepth(reasoning, efforts),
    values,
    catalog,
    t,
    languageNames: languages,
  };
}

function withSelection(model: PanelModel, providerId: string, modelId: string, endpoint: string): PanelModel {
  const efforts = effortsFor(model.catalog, providerId, modelId);
  const reasoning = model.values.reasoning || LOWEST;
  return {
    ...model,
    values: { ...model.values, provider: providerId, model: modelId, endpoint, reasoning },
    reasoningOptions: reasoningOptions(reasoning, efforts),
    reasoningResolved: resolveReasoningDepth(reasoning, efforts),
  };
}

/**
 * R3 + R2 + R4 together: choosing a provider moves the endpoint (unless overridden), reselects a
 * model from that provider's list, and re-derives the reasoning scale. Returns a NEW model.
 *
 * SPEC 2.1: `""` is the placeholder, not a provider, so it is not a choice — asking for it keeps
 * the current provider. Once a provider is chosen the picker cannot go back to empty; the
 * placeholder row stays in the markup but stays disabled.
 */
export function applyProviderChange(model: PanelModel, providerId: string): PanelModel {
  const requested = String(providerId ?? "").trim();
  if (requested === "") return model;
  const provider = model.providers.find((option) => option.value === requested);
  if (!provider) return model;
  const endpoint = resolveEndpointOnProviderChange(
    provider.value,
    { endpoint: model.values.endpoint, endpointCustom: model.values.endpointCustom },
    model.catalog,
  );
  const rows = model.modelsByProvider[provider.value] ?? [];
  // Keep the current model only if it belongs to the new provider's list.
  const keep = rows.some((row) => row.value === model.values.model) ? model.values.model : "";
  const nextModel = keep || rows.find((row) => row.value !== CUSTOM_MODEL)?.value || "";
  return withSelection(model, provider.value, nextModel, endpoint);
}

/** R3 — the user typed in the endpoint field: from now on it is theirs. */
export function applyEndpointEdit(model: PanelModel, endpoint: string): PanelModel {
  const custom = endpoint.trim() !== "";
  return { ...model, values: { ...model.values, endpoint, endpointCustom: custom } };
}

/** R2/R4 — the model picker changed: the reasoning scale follows the new model's declaration. */
export function applyModelChange(model: PanelModel, modelId: string): PanelModel {
  const selected = modelId === CUSTOM_MODEL ? model.values.model : modelId;
  return withSelection(model, model.values.provider, selected, model.values.endpoint);
}

/** R4 — an explicit level or `lowest`; both are stored verbatim, only `lowest` resolves. */
export function applyReasoningChange(model: PanelModel, setting: string): PanelModel {
  const reasoning = setting || LOWEST;
  const efforts = effortsFor(model.catalog, model.values.provider, model.values.model);
  return {
    ...model,
    values: { ...model.values, reasoning },
    reasoningOptions: reasoningOptions(reasoning, efforts),
    reasoningResolved: resolveReasoningDepth(reasoning, efforts),
  };
}

/**
 * A message from the panel. The panel never writes settings itself: it posts a draft (plus
 * which action it is), and the host validates, persists and re-renders. Returns `null` when the
 * message is not one we understand.
 */
export interface PanelMessage {
  action: "save" | "refresh" | "close";
  draft?: PanelDraft;
}

export function readPanelMessage(raw: unknown): PanelMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const message = raw as Partial<PanelMessage>;
  if (message.action !== "save" && message.action !== "refresh" && message.action !== "close") return null;
  const draft = message.draft && typeof message.draft === "object" ? message.draft : undefined;
  return { action: message.action, draft };
}

/**
 * Fold a draft over the current settings. Unknown keys are ignored; blanks fall back.
 *
 * SPEC 2.1: an empty provider in the draft is the disabled placeholder, never a choice — it
 * cannot clear a configured provider (only a fresh install legitimately stores `""`). Nothing
 * here invents a provider or an endpoint that the user did not choose.
 */
export function mergeDraft(current: Partial<PanelSettings>, draft: PanelDraft | undefined): Partial<PanelSettings> {
  if (!draft) return { ...current };
  const text = (value: unknown, fallback: string) => (typeof value === "string" ? value.trim() : fallback);
  const modelRaw = text(draft.model, current.model || "");
  // "Custom model…" plus an empty box means "not filled in yet", not "no model": keep the
  // configured one rather than saving a blank that the next translation would send.
  const model =
    modelRaw === CUSTOM_MODEL ? text(draft.customModel, "") || (current.model || "") : modelRaw;
  const provider = text(draft.provider, "");
  const currentProvider = (current.provider ?? "").trim();
  return {
    engine: current.engine || "google",
    target: text(draft.language, current.target || "zh-CN"),
    provider: provider === "" ? currentProvider : provider,
    model,
    endpoint: text(draft.endpoint, current.endpoint || ""),
    apiKey: typeof draft.apiKey === "string" ? draft.apiKey : String(current.apiKey || ""),
    reasoning: text(draft.reasoning, current.reasoning || LOWEST),
    endpointCustom: typeof draft.endpointCustom === "boolean" ? draft.endpointCustom : current.endpointCustom === true,
  };
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function optionsHtml(rows: ModelOption[], selected: string): string {
  const present = rows.some((row) => row.value === selected);
  let list = rows;
  if (!present && selected) {
    // A value the rows do not carry (a hand-typed model) still has to be the selected option.
    // It goes before a trailing `__custom__` action so that row stays last.
    const customIndex = rows.findIndex((row) => row.value === CUSTOM_MODEL);
    const extra = { value: selected, label: selected };
    list = customIndex === -1 ? [...rows, extra] : [...rows.slice(0, customIndex), extra, ...rows.slice(customIndex)];
  }
  return list
    .map(
      (row) =>
        `<option value="${escapeHtml(row.value)}"${row.value === selected ? " selected" : ""}>${escapeHtml(row.label)}</option>`,
    )
    .join("");
}

/**
 * SPEC 2.1 — the provider `<select>`: a disabled placeholder first when nothing is chosen, then
 * the one alphabetical list. The placeholder is not an option: it carries an empty value, cannot
 * be picked, and is never fed to the R2 sort (the rows below it are the sortable list).
 */
function providerOptionsHtml(model: PanelModel): string {
  const values = model.values;
  if (!isUnconfigured(model)) return optionsHtml(model.providers, values.provider);
  const placeholder = `<option value="" disabled selected>${escapeHtml(model.t("providerPlaceholder"))}</option>`;
  // The real rows still render behind the placeholder so the list is visible and scrolls.
  return `${placeholder}${optionsHtml(model.providers, "")}`;
}

/** SPEC 2.1 — an inert picker shows only its label row; it offers nothing to pick. */
function disabledOptionsHtml(label: string): string {
  return `<option value="" selected disabled>${escapeHtml(label)}</option>`;
}

function reasoningLabels(model: PanelModel, t: Translator): ModelOption[] {
  const resolved = model.reasoningResolved;
  return model.reasoningOptions.map((option) => {
    if (option.value === LOWEST) {
      const label = resolved ? t("reasoningLowest", { RESOLVED: resolved }) : t("reasoningNotDeclared");
      return { value: option.value, label };
    }
    return { value: option.value, label: option.value === "none" ? t("reasoningNone") : option.value };
  });
}

/** The one HTML string the panel renders. Every visible label goes through `t`. */
export function renderPanelHtml(model: PanelModel, status = ""): string {
  const t = model.t;
  const values = model.values;
  const unconfigured = isUnconfigured(model);
  const reasoningRows = reasoningLabels(model, t);
  const modelRows = model.modelsByProvider[values.provider] ?? [];
  const isCustomModel = !modelRows.some((row) => row.value === values.model) && values.model !== "";
  // Keep the raw id selected: `optionsHtml` appends it after the custom row, and a select that
  // silently jumps to another model is worse than one row the catalogue does not know.
  const modelSelectValue = values.model;
  // The box is visible whenever the select is not on a catalogue row, so an id the catalogue
  // does not list stays visible and editable instead of looking like a blank field.
  const showCustomBox = modelRows.length > 0 && (isCustomModel || modelSelectValue === CUSTOM_MODEL);
  const reasoningHint = model.reasoningResolved
    ? t("hintReasoning", { RESOLVED: model.reasoningResolved })
    : t("reasoningNotDeclared");

  return `<!DOCTYPE html>
<html lang="${escapeHtml(t("htmlLang"))}">
<head>
<meta charset="utf-8">
<style>
  body { font-family: sans-serif; font-size: 13px; margin: 12px; }
  label { display: block; margin: 10px 0 2px; font-weight: 600; }
  select, input { width: 100%; box-sizing: border-box; padding: 4px; }
  select:disabled, input:disabled { color: #888; background: #f5f5f5; }
  .hint { color: #666; font-size: 11px; margin: 2px 0 0; }
  .row { display: flex; gap: 12px; }
  .row > div { flex: 1; }
  .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .panel-head h2 { margin: 0; }
  .panel-close { border: 1px solid #aaa; border-radius: 4px; background: #fff; color: #333; font-size: 12px; line-height: 1.4; padding: 2px 8px; cursor: pointer; white-space: nowrap; }
  .panel-close:hover { background: #eee; }
  .actions { margin-top: 16px; display: flex; gap: 8px; }
  #status { color: #666; margin-top: 8px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<form id="dualtran" onsubmit="return false">
  <div class="panel-head">
    <h2>${escapeHtml(t("panelTitle"))}</h2>
    <button id="close" class="panel-close" type="button" aria-label="${escapeHtml(t("closeButton"))}" title="${escapeHtml(t("closeButton"))}">${escapeHtml(t("closeButton"))}</button>
  </div>
  <p class="hint">${escapeHtml(t("panelIntro"))}</p>

  <div class="row">
    <div>
      <label for="engine">${escapeHtml(t("labelEngine"))}</label>
      <select id="engine">
        <option value="google"${values.engine === "google" ? " selected" : ""}>${escapeHtml(t("engineGoogle"))}</option>
        <option value="ai"${values.engine === "ai" ? " selected" : ""}>${escapeHtml(t("engineAi"))}</option>
      </select>
      <p class="hint">${escapeHtml(t("hintEngine"))}</p>
    </div>
    <div>
      <label for="target">${escapeHtml(t("labelTarget"))}</label>
      <select id="target">${optionsHtml(model.languages, values.target)}</select>
      <p class="hint">${escapeHtml(t("hintTarget"))}</p>
    </div>
  </div>

  <label for="provider">${escapeHtml(t("labelProvider"))}</label>
  <select id="provider">${providerOptionsHtml(model)}</select>
  <p class="hint">${escapeHtml(t("hintProvider"))}</p>

  <label for="model">${escapeHtml(t("labelModel"))}</label>
  <select id="model"${unconfigured ? ' disabled aria-disabled="true"' : ""}>${unconfigured ? disabledOptionsHtml(t("providerRequiredForModel")) : optionsHtml(modelRows, modelSelectValue)}</select>
  <input id="customModel" type="text" placeholder="${escapeHtml(t("customModelPlaceholder"))}" value="${escapeHtml(showCustomBox ? values.model : "")}"${showCustomBox ? "" : " hidden"}>
  <p class="hint">${escapeHtml(t("hintModel"))}</p>

  <label for="endpoint">${escapeHtml(t("labelEndpoint"))}</label>
  <input id="endpoint" type="text" data-custom="${values.endpointCustom ? "true" : "false"}" placeholder="${escapeHtml(ENDPOINT_PLACEHOLDER)}" value="${escapeHtml(values.endpoint)}">
  <p class="hint">${escapeHtml(t("hintEndpoint"))}</p>

  <div class="row">
    <div>
      <label for="apiKey">${escapeHtml(t("labelApiKey"))}</label>
      <input id="apiKey" type="password" autocomplete="off" value="${escapeHtml(values.apiKey)}">
      <p class="hint">${escapeHtml(t("hintApiKey"))}</p>
    </div>
    <div>
      <label for="reasoning">${escapeHtml(t("labelReasoning"))}</label>
      <select id="reasoning"${unconfigured ? ' disabled aria-disabled="true"' : ""}>${optionsHtml(reasoningRows, values.reasoning)}</select>
      <p class="hint">${escapeHtml(reasoningHint)}</p>
    </div>
  </div>

  <div class="actions">
    <button id="save" type="button">${escapeHtml(t("saveButton"))}</button>
    <button id="refresh" type="button">${escapeHtml(t("refreshButton"))}</button>
  </div>
  <div id="status" role="status">${escapeHtml(status)}</div>
</form>
</body>
</html>`;
}
