declare const joplin: any;
import type { Engine } from "./translate";
import {
  buildChatRequest,
  chunkText,
  describeFetchFailure,
  googleUrl,
  parseChatResponse,
  parseGoogleResponse,
} from "./translate";

/**
 * Joplin plugins run in the Electron renderer with Node integration, so a plain `fetch` is not
 * subject to CORS — unlike the browser extension and the Logseq sandbox. That means every
 * OpenAI-compatible provider works here, including a locally hosted Ollama.
 */

const SECTION = "dualtran";

async function settings(): Promise<{ engine: Engine; target: string; endpoint: string; apiKey: string; model: string }> {
  const values = (await joplin.settings.values(["engine", "target", "endpoint", "apiKey", "model"])) as Record<string, string>;
  return {
    engine: (values.engine as Engine) || "google",
    target: values.target || "zh-CN",
    endpoint: values.endpoint || "https://api.openai.com/v1",
    apiKey: values.apiKey || "",
    model: values.model || "gpt-4o-mini",
  };
}

async function translateOne(text: string): Promise<string> {
  const config = await settings();
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

  const { url, init } = buildChatRequest(
    { endpoint: config.endpoint, apiKey: config.apiKey, model: config.model },
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

async function translateText(text: string): Promise<string> {
  const chunks = chunkText(text);
  const out: string[] = [];
  for (const chunk of chunks) out.push(await translateOne(chunk));
  return out.join("\n\n");
}

/** Translate the open note into a sibling note, leaving the source untouched. */
async function translateCurrentNote(): Promise<void> {
  const note = await joplin.workspace.selectedNote();
  if (!note) {
    await joplin.views.dialogs.showMessageBox("Open a note first.");
    return;
  }
  const body = (note.body || "").trim();
  if (!body) {
    await joplin.views.dialogs.showMessageBox("This note is empty.");
    return;
  }
  try {
    const config = await settings();
    const translated = await translateText(body);
    const parentId = note.parent_id;
    const folder = await joplin.data.get(["folders", parentId], { fields: ["id", "title"] });
    await joplin.data.post(["notes"], null, {
      parent_id: parentId,
      title: `${note.title || "Untitled"} · ${config.target}`,
      body: translated,
    });
    await joplin.views.dialogs.showMessageBox(`Translated into a new note in "${folder.title}".`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await joplin.views.dialogs.showMessageBox(`Translation failed: ${message}`);
  }
}

/** Translate the current selection and insert it below the selected paragraph. */
async function translateSelection(): Promise<void> {
  const note = await joplin.workspace.selectedNote();
  if (!note) {
    await joplin.views.dialogs.showMessageBox("Open a note first.");
    return;
  }
  let selection = "";
  try {
    selection = String((await joplin.commands.execute("selectedText")) || "");
  } catch {
    selection = "";
  }
  if (!selection.trim()) {
    await joplin.views.dialogs.showMessageBox("Select some text first.");
    return;
  }
  try {
    const translated = await translateText(selection.trim());
    const body = `${note.body || ""}`.replace(selection, `${selection}\n\n${translated}`);
    await joplin.data.put(["notes", note.id], null, { body });
    await joplin.commands.execute("editor.setText", body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await joplin.views.dialogs.showMessageBox(`Translation failed: ${message}`);
  }
}

joplin.plugins.register({
  onStart: async () => {
    await joplin.settings.registerSection(SECTION, {
      label: "DualTran",
      iconName: "fas fa-language",
    });
    await joplin.settings.registerSettings({
      engine: {
        value: "google",
        type: 4,
        section: SECTION,
        label: "Translation engine",
        description: "Google needs no key; AI uses an OpenAI-compatible endpoint.",
        options: { google: "Google Translate", ai: "AI (OpenAI-compatible)" },
      },
      target: {
        value: "zh-CN",
        type: 2,
        section: SECTION,
        label: "Target language",
        description: "Language code, e.g. zh-CN, en, ja.",
      },
      endpoint: {
        value: "https://api.openai.com/v1",
        type: 2,
        section: SECTION,
        label: "AI endpoint",
        description: "Base URL; /chat/completions is appended when missing. A local Ollama works here (http://127.0.0.1:11434/v1).",
      },
      apiKey: { value: "", type: 2, section: SECTION, label: "API key", description: "Stored in this profile only." },
      model: { value: "gpt-4o-mini", type: 2, section: SECTION, label: "Model" },
    });

    await joplin.commands.register({
      name: "dualtranTranslateNote",
      label: "DualTran: translate note into a new note",
      iconName: "fas fa-language",
      execute: translateCurrentNote,
    });
    await joplin.commands.register({
      name: "dualtranTranslateSelection",
      label: "DualTran: translate selection below",
      iconName: "fas fa-align-left",
      execute: translateSelection,
    });
    await joplin.views.menuItems.create("dualtranMenuNote", "dualtranTranslateNote", 2);
    await joplin.views.menuItems.create("dualtranMenuSel", "dualtranTranslateSelection", 2);
  },
});
