/**
 * End-to-end smoke test of the built plugin against a fake Joplin host.
 *
 * The unit tests cover the pure decisions; this one proves the wiring: `onStart` registers the
 * settings, the command and the panel, `dualtranOpenSettings` renders real HTML into the view,
 * and a provider change posted through `onMessage` persists the endpoint autofill (R3) and
 * re-renders. It loads `dist/index.js` — the artifact that ships — not the sources.
 *
 * Skipped when dist/ is absent (fresh checkout, `npm test` before `npm run build`).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = resolve(root, "dist/index.js");
const SECTION = "dualtran";

interface FakeHost {
  settings: Record<string, unknown>;
  html: string[];
  registered: Record<string, { label?: string; description?: string; public?: boolean; type?: number; section?: string }>;
  sections: Record<string, { label?: string }>;
  commands: Map<string, () => Promise<unknown>>;
  handlers: Array<(message: unknown) => Promise<unknown>>;
  shown: number;
  visible: boolean;
  onStart: (() => Promise<void>) | null;
}

function boot(): FakeHost {
  const host: FakeHost = {
    settings: {
      engine: "ai",
      target: "zh-CN",
      provider: "openai",
      model: "gpt-4.1",
      endpoint: "",
      apiKey: "k",
      reasoning: "lowest",
    },
    html: [],
    registered: {},
    sections: {},
    commands: new Map(),
    handlers: [],
    shown: 0,
    visible: true,
    onStart: null,
  };

  const joplin = {
    plugins: {
      register: (definition: { onStart: () => Promise<void> }) => {
        host.onStart = definition.onStart;
      },
    },
    settings: {
      registerSection: async (name: string, section: { label?: string }) => {
        host.sections[name] = section;
      },
      registerSettings: async (settings: FakeHost["registered"]) => {
        Object.assign(host.registered, settings);
      },
      values: async (keys: string[]) => Object.fromEntries(keys.map((key) => [key, host.settings[key]])),
      setValue: async (key: string, value: unknown) => {
        host.settings[key] = value;
      },
    },
    commands: {
      register: (command: { name: string; execute: () => Promise<unknown> }) => {
        host.commands.set(command.name, command.execute);
      },
      execute: async () => "",
    },
    views: {
      dialogs: { showMessageBox: async () => 0 },
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
        show: async (_handle: string, show: boolean) => {
          host.shown += show ? 1 : 0;
          host.visible = show;
        },
      },
    },
  };

  const sandbox: Record<string, unknown> = {
    joplin,
    // Offline: the catalogue refresh must fall back to the built-ins instead of hanging.
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    console,
    setTimeout,
    clearTimeout,
  };
  runInContext(readFileSync(bundlePath, "utf8"), createContext(sandbox));
  return host;
}

const skip = !existsSync(bundlePath);

describe.skipIf(skip)("built plugin", () => {
  it("starts, registers the panel command and the settings, and renders the panel", async () => {
    const host = boot();
    expect(host.onStart).toBeTypeOf("function");
    await host.onStart?.();

    expect(host.commands.has("dualtranOpenSettings")).toBe(true);
    expect(host.commands.has("dualtranTranslateNote")).toBe(true);
    expect(host.registered.target?.label).toMatch(/advanced override/i);
    expect(host.registered.model?.label).toMatch(/advanced override/i);
    expect(host.registered.provider).toBeDefined();
    expect(host.handlers.length).toBe(1);

    await host.commands.get("dualtranOpenSettings")?.();
    expect(host.shown).toBe(1);
    const html = host.html[host.html.length - 1] ?? "";
    expect(html).toContain('<select id="target">');
    expect(html).toContain('<select id="provider">');
    expect(html).toContain('<select id="reasoning">');
    // Offline: the built-in providers still populate the picker.
    expect(html).toContain("Ollama (local)");
  });

  it("registers every user-facing setting as public, so Options > Plugins lists DualTran", async () => {
    const host = boot();
    await host.onStart?.();

    // Joplin's config screen filters on `public`; a private setting is registered but never
    // rendered, which is exactly how v0.1.3 shipped an invisible settings page.
    expect(host.sections[SECTION]?.label).toBe("DualTran");
    for (const key of ["engine", "target", "provider", "model", "endpoint", "apiKey", "reasoning"]) {
      expect(host.registered[key], key).toBeDefined();
      expect(host.registered[key]?.public, key).toBe(true);
      expect(host.registered[key]?.section, key).toBe(SECTION);
      expect(host.registered[key]?.type, key).toBe(2);
    }
    // The catalogue cache is internal and must not add a sixth field to the options page.
    expect(host.registered.catalogCache?.public).toBe(false);
  });

  it("saves a provider switch and autofills the endpoint", async () => {
    const host = boot();
    await host.onStart?.();
    await host.commands.get("dualtranOpenSettings")?.();
    const handler = host.handlers[0];

    const saved = await handler({
      action: "save",
      draft: {
        engine: "ai",
        language: "ja",
        provider: "deepseek",
        model: "deepseek-chat",
        endpoint: "",
        endpointCustom: false,
        apiKey: "k2",
        reasoning: "lowest",
      },
    });

    expect(saved).toBe(true);
    expect(host.settings.provider).toBe("deepseek");
    expect(host.settings.target).toBe("ja");
    expect(host.settings.endpoint).toBe("https://api.deepseek.com");
    expect(host.settings.apiKey).toBe("k2");
    // A re-render happened and reflects the new selection.
    const html = host.html[host.html.length - 1] ?? "";
    expect(html).toMatch(/<option value="deepseek" selected>/);
    expect(html).toContain('value="https://api.deepseek.com"');
  });

  it("closes the panel when the close button posts close", async () => {
    const host = boot();
    await host.onStart?.();
    await host.commands.get("dualtranOpenSettings")?.();
    expect(host.visible).toBe(true);
    expect(await host.handlers[0]({ action: "close" })).toBe(true);
    expect(host.visible).toBe(false);
  });

  it("ignores a message that is not a panel command", async () => {
    const host = boot();
    await host.onStart?.();
    await host.commands.get("dualtranOpenSettings")?.();
    expect(await host.handlers[0]({ action: "rm -rf" })).toBe(false);
    expect(await host.handlers[0](null)).toBe(false);
  });

  it("survives a failed catalogue refresh and reports it", async () => {
    const host = boot();
    await host.onStart?.();
    await host.commands.get("dualtranOpenSettings")?.();
    const before = host.html.length;
    expect(await host.handlers[0]({ action: "refresh" })).toBe(true);
    expect(host.html.length).toBe(before + 1);
    expect(host.html[host.html.length - 1]).toContain('role="status"');
  });
});
