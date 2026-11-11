/**
 * Provider / model / language catalogue — pure, no Joplin API, no network.
 *
 * Two sources feed one list:
 *   - `BUILTINS`: the endpoints a translator realistically needs, with a known API base so the
 *     endpoint field can autofill even with no catalogue (offline first run);
 *   - models.dev: ~235 providers, refreshed daily by the settings panel.
 *
 * The list users see is ONE alphabetical sequence. There is no "built-in section, then the rest"
 * divider: the second a list is split, people stop scrolling and never find the provider they
 * actually pay for. Aliases (`google-gemini` → `google`) collapse onto the canonical id.
 */

export const LOWEST = "lowest";

/** Sentinel value of the "type a model id" row. Kept out of the alphabetical sort. */
export const CUSTOM_MODEL = "__custom__";
/** Sentinel provider value: the endpoint is the user's own, the id is not in the catalogue. */
export const CUSTOM_PROVIDER = "__custom_provider__";

/** Effort levels models.dev uses, cheapest first. `lowest` resolves to the first one declared. */
export const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface ProviderEntry {
  id: string;
  name: string;
  /** API base from the catalogue; `""` when models.dev does not publish one. */
  api: string;
  source: "built-in" | "models.dev";
  models: CatalogModel[];
}

export interface CatalogModel {
  id: string;
  name: string;
  /** Effort levels the model declares, `[]` when it declares none. */
  efforts: string[];
}

export interface Catalog {
  providers: Record<string, ProviderEntry>;
  /** The alias map that was applied, for diagnostics in the panel. */
  aliases: Record<string, string>;
}

export interface ProviderOption {
  value: string;
  label: string;
  source: "built-in" | "models.dev" | "custom";
  api: string;
}

export interface ModelOption {
  value: string;
  label: string;
}

/**
 * Built-ins. `google-gemini` is listed under its canonical models.dev id so an alias never
 * produces a duplicate row; `local` has no catalogue entry at all and must survive a refresh.
 */
export const BUILTINS: Record<string, { name: string; api: string; models: string[] }> = {
  openai: {
    name: "OpenAI",
    api: "https://api.openai.com/v1",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1"],
  },
  openrouter: {
    name: "OpenRouter",
    api: "https://openrouter.ai/api/v1",
    models: ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet", "google/gemini-2.0-flash-001"],
  },
  deepseek: {
    name: "DeepSeek",
    api: "https://api.deepseek.com",
    models: ["deepseek-chat"],
  },
  moonshotai: {
    name: "Moonshot AI",
    api: "https://api.moonshot.ai/v1",
    models: ["moonshot-v1-8k"],
  },
  zhipuai: {
    name: "Zhipu AI",
    api: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4-flash"],
  },
  "alibaba-cn": {
    name: "Alibaba (China)",
    api: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-plus"],
  },
  "ollama-local": {
    name: "Ollama (local)",
    api: "http://127.0.0.1:11434/v1",
    models: ["llama3.1", "qwen2.5"],
  },
  lmstudio: {
    name: "LM Studio (local)",
    api: "http://127.0.0.1:1234/v1",
    models: [],
  },
};

/** Display-only aliases. The canonical id wins; the alias is never a second row. */
const DEFAULT_ALIASES: Record<string, string> = {
  "google-gemini": "google",
  moonshot: "moonshotai",
  grok: "xai",
  zhipu: "zhipuai",
  qwen: "alibaba-cn",
  together: "togetherai",
  "azure-openai": "azure",
};

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** models.dev publishes a few templated bases; they are not usable as a literal URL. */
function usableApi(api: unknown): string {
  const value = typeof api === "string" ? api.trim() : "";
  if (!value || value.includes("${")) return "";
  return value;
}

/**
 * Turn the models.dev `api.json` payload (or anything shaped like it) into a `Catalog`.
 * Tolerant by design: a malformed provider or model is skipped, not fatal — the catalogue is
 * an enhancement, and a bad entry must not take the settings panel down.
 */
export function projectCatalog(raw: unknown, aliases: Record<string, string> = DEFAULT_ALIASES): Catalog {
  const providers: Record<string, ProviderEntry> = {};
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  for (const [key, value] of Object.entries(source)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as { id?: unknown; name?: unknown; api?: unknown; models?: unknown };
    const rawId = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : key.trim();
    if (!rawId) continue;
    const id = aliases[rawId] || rawId;
    const models: CatalogModel[] = [];
    if (entry.models && typeof entry.models === "object") {
      for (const [modelKey, modelValue] of Object.entries(entry.models as Record<string, unknown>)) {
        if (!modelValue || typeof modelValue !== "object") continue;
        const model = modelValue as { id?: unknown; name?: unknown; reasoning_options?: unknown };
        const modelId = typeof model.id === "string" && model.id.trim() ? model.id.trim() : modelKey;
        if (!modelId) continue;
        models.push({
          id: modelId,
          name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : modelId,
          efforts: effortsOf(model.reasoning_options),
        });
      }
    }
    if (models.length === 0) continue;

    const existing = providers[id];
    if (existing) {
      // Alias collision (e.g. `google-gemini` and `google` both present): merge, catalogue wins
      // on the API base because models.dev is the fresher source.
      const byId = new Map(existing.models.map((model) => [model.id, model]));
      for (const model of models) if (!byId.has(model.id)) byId.set(model.id, model);
      providers[id] = {
        ...existing,
        api: usableApi(entry.api) || existing.api,
        name: existing.source === "models.dev" ? existing.name : String(entry.name || existing.name),
        models: [...byId.values()],
      };
      continue;
    }

    providers[id] = {
      id,
      name:
        typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id,
      api: usableApi(entry.api),
      source: "models.dev",
      models,
    };
  }

  // Built-ins fill the gaps: an endpoint known to work, and its models when the catalogue is thin.
  for (const [id, builtIn] of Object.entries(BUILTINS)) {
    const canonical = aliases[id] || id;
    const existing = providers[canonical];
    const builtInModels: CatalogModel[] = builtIn.models.map((modelId) => ({
      id: modelId,
      name: modelId,
      efforts: [],
    }));
    if (!existing) {
      providers[canonical] = {
        id: canonical,
        name: builtIn.name,
        api: builtIn.api,
        source: "built-in",
        models: builtInModels,
      };
      continue;
    }
    if (!existing.api) existing.api = builtIn.api;
    const byId = new Map(existing.models.map((model) => [model.id, model]));
    for (const model of builtInModels) if (!byId.has(model.id)) byId.set(model.id, model);
    existing.models = [...byId.values()];
  }

  return { providers, aliases };
}

/** models.dev `reasoning_options`: `[{type:"effort", values:[…]}, {type:"toggle"}, …]`. */
export function effortsOf(reasoningOptions: unknown): string[] {
  if (!Array.isArray(reasoningOptions)) return [];
  const efforts = new Set<string>();
  for (const option of reasoningOptions) {
    if (!option || typeof option !== "object") continue;
    const entry = option as { type?: unknown; values?: unknown };
    if (entry.type !== "effort" || !Array.isArray(entry.values)) continue;
    for (const value of entry.values) if (typeof value === "string" && value.trim()) efforts.add(value.trim());
  }
  return [...efforts];
}

/**
 * One alphabetical list, no dividers. Ordering is by label, except that the "custom endpoint"
 * row is pinned last: it is an action, not a provider, and sorting it into the As helps nobody.
 */
export function buildProviderList(catalog: Catalog): ProviderOption[] {
  const list: ProviderOption[] = Object.values(catalog.providers).map((provider) => ({
    value: provider.id,
    label: provider.name || provider.id,
    source: provider.source,
    api: provider.api,
  }));
  list.sort((a, b) => collator.compare(a.label, b.label) || collator.compare(a.value, b.value));
  return list;
}

export function providerById(catalog: Catalog, providerId: string): ProviderEntry | undefined {
  return catalog.providers[providerId];
}

/** Model picker rows for one provider: alphabetical, the free-text row last. */
export function modelsForProvider(catalog: Catalog, providerId: string): ModelOption[] {
  const provider = catalog.providers[providerId];
  const seen = new Set<string>();
  const catalogRows: ModelOption[] = [];
  for (const model of provider?.models ?? []) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    catalogRows.push({
      value: model.id,
      // The id is what gets sent to the API; show it when the display name differs enough to matter.
      label: model.name === model.id ? model.id : `${model.name} (${model.id})`,
    });
  }
  catalogRows.sort((a, b) => collator.compare(a.label, b.label) || collator.compare(a.value, b.value));
  return catalogRows;
}

/**
 * R3 — the endpoint follows the provider, unless the user typed their own.
 * `endpointCustom` is set by the panel the moment the field is edited, and is the whole
 * difference between "autofill" and "clobbering someone's proxy URL".
 */
export function resolveEndpointOnProviderChange(
  providerId: string,
  current: { endpoint: string; endpointCustom: boolean },
  catalog: Catalog,
): string {
  if (current.endpointCustom && current.endpoint.trim()) return current.endpoint;
  if (providerId === CUSTOM_PROVIDER) return current.endpoint.trim() ? current.endpoint : "";
  const provider = catalog.providers[providerId];
  return provider?.api || current.endpoint;
}

/**
 * R4 — `lowest` is a request ("cheapest level this model actually offers"), because models
 * disagree wildly: some start at `none`, some at `low`, some declare no effort scale at all.
 * An explicit level passes through untouched; only `lowest` resolves.
 */
export function resolveReasoningDepth(setting: string, offered: readonly string[]): string {
  const levels = offered
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
  if (setting !== LOWEST) return setting;
  if (levels.length === 0) return "";
  for (const effort of EFFORT_ORDER) if (levels.includes(effort)) return effort;
  // Unknown vocabulary: trust the order the provider declared.
  return levels[0];
}

/** R4 — what the reasoning picker offers: the sentinel, then the levels this model declares. */
export function reasoningOptions(setting: string, offered: readonly string[]): ModelOption[] {
  const levels = offered.map(String).filter((value, index, all) => value.trim() && all.indexOf(value) === index);
  const options: ModelOption[] = [{ value: LOWEST, label: LOWEST }];
  for (const level of levels) if (level !== LOWEST) options.push({ value: level, label: level });
  if (setting && setting !== LOWEST && !options.some((option) => option.value === setting)) {
    options.push({ value: setting, label: setting });
  }
  return options;
}

/**
 * R1 — the target language picker. Readable names, not raw codes, and the current value is
 * always present: a language configured by hand before this picker existed must not silently
 * fall back to the first row.
 */
export function languageOptions(names: Record<string, string>, current: string): ModelOption[] {
  const seen = new Set<string>();
  const options: ModelOption[] = [];
  for (const [code, name] of Object.entries(names)) {
    const value = code.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const label = String(name || "").trim() || value;
    options.push({ value, label: label === value ? value : `${label} (${value})` });
  }
  options.sort((a, b) => collator.compare(a.label, b.label) || collator.compare(a.value, b.value));

  const wanted = (current || "").trim();
  if (wanted && !seen.has(wanted)) {
    options.push({ value: wanted, label: `${wanted} (${wanted})` });
  }
  return options;
}

/** models.dev api.json, cached for a day against a quota-free fallback. */
export const CATALOG_URL = "https://models.dev/api.json";
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

export interface CatalogCache {
  fetchedAt: number;
  raw: unknown;
}

export function isCatalogCacheFresh(cache: CatalogCache | null | undefined, now: number): boolean {
  if (!cache || typeof cache.fetchedAt !== "number" || !cache.raw) return false;
  const age = now - cache.fetchedAt;
  return age >= 0 && age < CATALOG_TTL_MS;
}

/** Parse the persisted cache defensively: a half-written string must not break the panel. */
export function parseCatalogCache(text: string | null | undefined): CatalogCache | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as CatalogCache;
    if (!parsed || typeof parsed !== "object" || !parsed.raw) return null;
    return parsed;
  } catch {
    return null;
  }
}
