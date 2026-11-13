/**
 * The settings panel is a webview: `dist/dualtran-panel.js` runs inside the panel document and
 * talks to the plugin through `webviewApi.postMessage`. Unit tests that call the plugin's
 * `onMessage` handler directly prove nothing about that wiring — a panel whose script never
 * attached a listener answers every click with silence, which is exactly how v0.1.5 shipped a
 * dead "close" button.
 *
 * These tests execute the shipped panel script against a real DOM (jsdom) in the two orders
 * Joplin can produce:
 *   1. the script runs before the panel HTML exists (addScript is async, `setHtml` follows), and
 *   2. the script runs after it (a re-render / fresh webview).
 * In both cases a click must post the message the plugin understands.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

import { LOWEST, projectCatalog } from "../src/catalog";
import { createTranslator } from "../src/i18n";
import { buildPanelModel, renderPanelHtml } from "../src/settingsPanel";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const panelScriptPath = resolve(root, "dist/dualtran-panel.js");
const sample = JSON.parse(readFileSync(resolve(root, "tests/fixtures/conformance/models-dev-sample.json"), "utf8")) as unknown;
const languageNames = JSON.parse(readFileSync(resolve(root, "tests/fixtures/conformance/language-names.json"), "utf8")) as Record<string, string>;
const en = JSON.parse(readFileSync(resolve(root, "locales/en.json"), "utf8")) as Record<string, string>;
const t = createTranslator(en);
const catalog = projectCatalog(sample);

const panelHtml = renderPanelHtml(
  buildPanelModel(
    {
      engine: "ai",
      target: "zh-CN",
      provider: "openai",
      model: "gpt-5.6-luna",
      endpoint: "https://api.openai.com/v1",
      apiKey: "",
      reasoning: LOWEST,
    },
    catalog,
    t,
    languageNames,
  ),
);

const skip = !existsSync(panelScriptPath);

/** A DOM with the panel markup installed, plus the panel script evaluated at a chosen moment. */
function makePanel(options: { scriptFirst: boolean; evaluateTwice?: boolean }) {
  const dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
    runScripts: "outside-only",
    url: "https://panel.test/",
  });
  const posts: unknown[] = [];
  (dom.window as unknown as { webviewApi: unknown }).webviewApi = {
    postMessage: (message: unknown) => {
      posts.push(message);
      return Promise.resolve(true);
    },
  };
  const script = readFileSync(panelScriptPath, "utf8");
  const parsed = new JSDOM(panelHtml).window.document;

  const installHtml = () => {
    dom.window.document.head.innerHTML = parsed.head.innerHTML;
    dom.window.document.body.innerHTML = parsed.body.innerHTML;
  };

  if (!options.scriptFirst) installHtml();
  dom.window.eval(script);
  if (options.scriptFirst) installHtml();
  if (options.evaluateTwice) dom.window.eval(script);

  const click = (id: string) => {
    const element = dom.window.document.getElementById(id) as HTMLElement | null;
    expect(element, `#${id} exists`).toBeTruthy();
    element?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  };

  return { dom, posts, click, installHtml };
}

const tick = () => new Promise((resolveTick) => setTimeout(resolveTick, 0));

describe.skipIf(skip)("panel script in a real DOM", () => {
  it("posts close when the HTML is already there (fresh webview)", () => {
    const { posts, click } = makePanel({ scriptFirst: false });
    click("close");
    expect(posts).toEqual([{ action: "close" }]);
  });

  it("still attaches when the script runs before the panel HTML (the setHtml race)", async () => {
    const { posts, click } = makePanel({ scriptFirst: true });
    await tick();
    click("close");
    expect(posts).toEqual([{ action: "close" }]);
  });

  it("rebinds after setHtml replaces the body (a re-render)", async () => {
    const { posts, click, installHtml } = makePanel({ scriptFirst: true });
    await tick();
    click("close");
    expect(posts).toEqual([{ action: "close" }]);
    // Joplin's setHtml does `contentElement.innerHTML = html`: new nodes, same script.
    installHtml();
    await tick();
    click("close");
    expect(posts).toEqual([{ action: "close" }, { action: "close" }]);
  });

  it("does not double-post when the script is evaluated twice", () => {
    const { posts, click } = makePanel({ scriptFirst: false, evaluateTwice: true });
    click("close");
    expect(posts.filter((message) => (message as { action?: string }).action === "close")).toHaveLength(1);
  });

  it("wires the controls, not only the close button", () => {
    const { posts, click } = makePanel({ scriptFirst: false });
    click("save");
    click("refresh");
    expect(posts).toEqual([{ action: "save", draft: expect.any(Object) }, { action: "refresh", draft: expect.any(Object) }]);
  });

  it("never puts a script tag in the HTML: setHtml assigns innerHTML, which does not execute it", () => {
    expect(panelHtml).not.toMatch(/<script/i);
  });
});
