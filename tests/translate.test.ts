import { describe, expect, it } from "vitest";
import {
  buildChatRequest,
  chatCompletionsUrl,
  chunkText,
  describeFetchFailure,
  googleUrl,
  normalizeEndpoint,
  parseChatResponse,
  parseGoogleResponse,
} from "../src/translate";

describe("endpoint handling", () => {
  it("rejects a schemeless endpoint instead of building a relative request", () => {
    expect(() => normalizeEndpoint("api.openai.com/v1")).toThrow(/must start with http/);
  });

  it("accepts the three shapes users paste", () => {
    expect(chatCompletionsUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/chat/completions");
    expect(chatCompletionsUrl("https://api.deepseek.com")).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(chatCompletionsUrl("https://openrouter.ai/api/v1/chat/completions")).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
  });

  it("strips trailing slashes", () => {
    expect(chatCompletionsUrl("http://127.0.0.1:11434/v1/")).toBe("http://127.0.0.1:11434/v1/chat/completions");
  });
});

describe("chat request", () => {
  it("asks for the target language and forbids commentary", () => {
    const { url, init } = buildChatRequest(
      { endpoint: "https://api.openai.com/v1", apiKey: "k", model: "gpt-4o-mini" },
      { text: "Hello", target: "zh-CN" },
    );
    const body = JSON.parse(String(init.body));
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages[0].content).toContain("zh-CN");
    expect(body.messages[1].content).toBe("Hello");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("omits Authorization when no key is configured", () => {
    const { init } = buildChatRequest(
      { endpoint: "http://127.0.0.1:11434/v1", apiKey: "", model: "llama3" },
      { text: "Hi", target: "en" },
    );
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe("response parsing", () => {
  it("reads the first choice", () => {
    expect(parseChatResponse({ choices: [{ message: { content: "你好" } }] })).toBe("你好");
  });

  it("surfaces the provider's error message", () => {
    expect(() => parseChatResponse({ error: { message: "invalid api key" } })).toThrow("invalid api key");
  });

  it("refuses an empty translation instead of writing a blank block", () => {
    expect(() => parseChatResponse({ choices: [{ message: { content: "   " } }] })).toThrow(/empty/);
  });

  it("joins the sentence pieces Google returns", () => {
    expect(parseGoogleResponse([ [["你好", "Hello"], ["世界", " world"]], null, "en" ])).toBe("你好世界");
  });

  it("rejects a Google payload that is not the expected shape", () => {
    expect(() => parseGoogleResponse({ error: "nope" })).toThrow(/Unexpected response/);
  });
});

describe("chunking", () => {
  it("keeps short text as one chunk", () => {
    expect(chunkText("hello")).toEqual(["hello"]);
  });

  it("splits on paragraph boundaries before hard-wrapping", () => {
    const text = ["a".repeat(40), "b".repeat(40), "c".repeat(40)].join("\n\n");
    const chunks = chunkText(text, 90);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n\n")).toBe(text);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(90);
  });

  it("hard-wraps a single oversized paragraph", () => {
    const chunks = chunkText("x".repeat(250), 100);
    expect(chunks).toEqual(["x".repeat(100), "x".repeat(100), "x".repeat(50)]);
  });

  it("drops empty input", () => {
    expect(chunkText("   \n\n  ")).toEqual([]);
  });
});

describe("error messages", () => {
  it("names CORS as a cause instead of reporting a bare network error", () => {
    const hint = describeFetchFailure(new TypeError("Failed to fetch"), "https://api.example.com/v1/chat/completions");
    expect(hint).toContain("CORS");
    expect(hint).toContain("https://api.example.com");
  });

  it("passes other errors through", () => {
    expect(describeFetchFailure(new Error("boom"), "https://x")).toBe("boom");
  });
});
