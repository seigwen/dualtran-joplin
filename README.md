# DualTran Translate for Joplin

**Translate a note without losing the original.** The translation is written to a new note
(`<title> · <lang>`), so the source stays exactly as it was.

Two engines:

- **Google Translate** — no key, no configuration
- **AI** — any OpenAI-compatible endpoint with your own key. Unlike the browser extension and
  the Logseq plugin, Joplin plugins run with Node integration, so there is no CORS wall: a
  local Ollama (`http://127.0.0.1:11434/v1`) works here too.

## Install

Build the plugin package and install it from Joplin:

```bash
git clone https://github.com/seigwen/dualtran-joplin
cd dualtran-joplin
npm install
npm run build          # produces joplin-plugin-dualtran.jpl
```

Then in Joplin: **Tools → Options → Plugins → Install from file** → pick `joplin-plugin-dualtran.jpl`.

## Commands

| Menu (Tools) | Effect |
|---|---|
| `DualTran: open settings panel` | Opens the plugin panel with provider/model/reasoning pickers |
| `DualTran: translate note into a new note` | Translates the open note into a sibling note, source untouched |
| `DualTran: translate selection below` | Inserts the translation under the selected text |

## Settings

Open **Tools → Options → Plugins → DualTran** (Joplin's settings page), or use
**Tools → DualTran: open settings panel** for the plugin's own dropdown panel. Both write the
same values; the panel adds the provider/model/reasoning pickers.

| Key | Default | Notes |
|---|---|---|
| `engine` | `google` | `google` or `ai` |
| `target` | `zh-CN` | any language code |
| `endpoint` | `https://api.openai.com/v1` | base URL; `/chat/completions` appended when missing |
| `apiKey` | empty | bearer token |
| `model` | `gpt-4o-mini` | model id |

## Status

- 104 tests (`npm test`), `tsc --noEmit` clean, host conformance PASS, `.jpl` builds (260 KB with
  the panel and 38 locales).
- **Verified in Joplin 3.7.21 (Linux, headless):** v0.1.4 loads without errors, and
  **Tools → Options → Plugins → DualTran** renders the settings page (engine, target, provider,
  model, endpoint, API key, reasoning). `Tools → DualTran: open settings panel` opens the
  dropdown panel.
- v0.1.3 on the Joplin catalogue was unconfigurable: its settings were private (hidden from
  Options) and its npm tarball packed a stale v0.1.2 archive with no panel. Fixed in v0.1.4.

## Licence

MPL-2.0.
