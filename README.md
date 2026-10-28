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
npm run build          # produces dualtran-joplin.jpl
```

Then in Joplin: **Tools → Options → Plugins → Install from file** → pick `dualtran-joplin.jpl`.

## Commands

| Menu (Tools) | Effect |
|---|---|
| `DualTran: translate note into a new note` | Translates the open note into a sibling note, source untouched |
| `DualTran: translate selection below` | Inserts the translation under the selected text |

## Settings

| Key | Default | Notes |
|---|---|---|
| `engine` | `google` | `google` or `ai` |
| `target` | `zh-CN` | any language code |
| `endpoint` | `https://api.openai.com/v1` | base URL; `/chat/completions` appended when missing |
| `apiKey` | empty | bearer token |
| `model` | `gpt-4o-mini` | model id |

## Status

- 16 unit tests (`npm test`), `tsc --noEmit` clean, `.jpl` builds (30 KB).
- **Verified end to end in Joplin 3.7.21 (Linux, headless):** the plugin loads
  (`Finished running onStart handler … (Took 154ms)`), settings read back correctly, and running
  `DualTran: translate note into a new note` on the English welcome note produced
  `1. Welcome to Joplin! · zh-CN` with a real Chinese translation.

## Licence

MPL-2.0.
