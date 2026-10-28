/**
 * Transport-agnostic translation core for the Logseq plugin.
 *
 * The plugin runs inside Logseq's sandboxed iframe, so every call is a plain `fetch` from a
 * page origin — no privileged APIs. That makes CORS the deciding constraint: a provider
 * either answers with `Access-Control-Allow-Origin` or the plugin cannot use it. Failures
 * therefore have to say "blocked by CORS", not "network error", or users chase the wrong fix.
 */

export type Engine = "ai" | "google";

export interface AiConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  temperature?: number;
}

export interface TranslateOptions {
  text: string;
  target: string;
  source?: string;
}

/** Normalise the endpoint the way the browser extension does: absolute, no trailing slash. */
export function normalizeEndpoint(endpoint: string): string {
  const trimmed = (endpoint || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`Endpoint must start with http:// or https:// (got "${endpoint}")`);
  }
  return trimmed;
}

/** `/v1/chat/completions` is what the AI SDK wants; users paste every variant of it. */
export function chatCompletionsUrl(endpoint: string): string {
  const base = normalizeEndpoint(endpoint);
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v\d+$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

export function buildChatRequest(config: AiConfig, options: TranslateOptions): { url: string; init: RequestInit } {
  const url = chatCompletionsUrl(config.endpoint);
  const system =
    `You translate into ${options.target}. Return only the translation, no commentary, ` +
    `no quotes, and preserve markdown, code spans and inline links exactly as they appear. ` +
    `If the text is already in ${options.target}, return it unchanged.`;
  const body = {
    model: config.model,
    temperature: config.temperature ?? 0,
    stream: false,
    messages: [
      { role: "system", content: system },
      { role: "user", content: options.text },
    ],
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  return { url, init: { method: "POST", headers, body: JSON.stringify(body) } };
}

export function parseChatResponse(payload: unknown): string {
  const data = payload as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
  if (data?.error?.message) throw new Error(data.error.message);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("The provider returned an empty translation");
  }
  return content.trim();
}

export function googleUrl(options: TranslateOptions): string {
  const params = new URLSearchParams({
    client: "gtx",
    sl: options.source || "auto",
    tl: options.target,
    dt: "t",
    q: options.text,
  });
  return `https://translate.googleapis.com/translate_a/single?${params.toString()}`;
}

/** The Google endpoint answers with a deeply nested array; sentence pieces sit at [0][n][0]. */
export function parseGoogleResponse(payload: unknown): string {
  const rows = (payload as unknown[])?.[0];
  if (!Array.isArray(rows)) throw new Error("Unexpected response from Google Translate");
  const text = rows
    .map((row) => (Array.isArray(row) ? String(row[0] ?? "") : ""))
    .join("")
    .trim();
  if (!text) throw new Error("Google Translate returned an empty translation");
  return text;
}

/**
 * Long blocks blow past provider limits and make one bad sentence poison the whole block.
 * Split on paragraph boundaries first, then hard-wrap anything still oversized.
 */
export function chunkText(text: string, limit = 1800): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= limit) return [clean];

  const parts: string[] = [];
  let current = "";
  for (const paragraph of clean.split(/\n{2,}/)) {
    if ((current + "\n\n" + paragraph).trim().length <= limit) {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
      continue;
    }
    if (current) parts.push(current);
    if (paragraph.length <= limit) {
      current = paragraph;
    } else {
      for (let i = 0; i < paragraph.length; i += limit) parts.push(paragraph.slice(i, i + limit));
      current = "";
    }
  }
  if (current) parts.push(current);
  return parts;
}

export function describeFetchFailure(error: unknown, url: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return (
      `Could not reach ${url}. Two common causes: the endpoint is unreachable, or the ` +
      `provider does not allow browser requests (CORS). Open the browser console: a CORS ` +
      `rejection is reported there, and only a server-side change or a different provider fixes it.`
    );
  }
  return message;
}
