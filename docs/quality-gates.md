# Quality gates

Each layer below exists because a real defect escaped the layer above it. A change is not
"tested" because one layer is green: the panel bug that shipped in 0.1.5 had passing unit tests
(the handler was called directly) and a rendered button, but the button had no click listener in
the real webview.

| Layer | Runs in | Proves |
|---|---|---|
| Unit (`vitest`) | `npm test` | pure decisions: panel model, draft merge, catalogue, i18n, translation |
| **Panel DOM contract** (`tests/panelDom.test.ts`, jsdom) | `npm test` | the **shipped** `dist/dualtran-panel.js` binds `#close`/`#save`/`#refresh` in every load order Joplin produces, exactly once, and re-binds after `setHtml` replaces the DOM |
| Fake host (`tests/plugin.test.ts`) | `npm test` | `onStart` wiring: settings registration, commands, panel handle, `onMessage`, `hide` |
| Host conformance | `npm run conformance` | provider/models/reasoning rules of the cross-host spec |
| Real Joplin e2e (`scripts/e2e/panel-smoke.mjs`) | manual / release | the button exists **and works** inside Joplin: opens, has one listener, hides the panel, survives re-render and save |
| Packaging | `npm run release` | the `.jpl` contains the current version and `dualtran-panel.js` |

## Why the DOM layer is mandatory

Joplin's panel host does not load the panel the way a browser loads a page:

- `joplin.views.panels.addScript()` appends a `<script>` to the webview **when the webview is
  ready** — which is before the plugin has called `setHtml`, so the script usually runs while the
  document is still empty.
- `joplin.views.panels.setHtml()` assigns `contentElement.innerHTML = html`. Browsers do **not**
  execute `<script>` tags inserted through `innerHTML`, and the panel script is not re-run on a
  re-render.

Consequences, all of which have bitten us:

1. A top-level `if (!form) return;` silently disables every control: the panel renders, the
   buttons are visible, clicks post nothing.
2. A script that binds once and disconnects its observer loses the buttons after the first
   re-render (every save/open calls `setHtml`).
3. A `<script src="dualtran-panel.js">` in the panel HTML resolves against the app's plugin shim
   directory and 404s — it can never work.

`src/panel.js` therefore binds through `init()`, keeps a permanent `MutationObserver` on
`document.documentElement`, and marks the form (`data-dualtran-ready`) so a second evaluation
cannot double-bind. The jsdom test exercises exactly these three cases against `dist/`, not
`src/`.

## Real-Joplin e2e

```bash
# Joplin must run with a debug port; a tunnel from the VPS is enough:
#   ssh -N -L 9225:127.0.0.1:9225 dual-home
node scripts/e2e/panel-smoke.mjs --port 9225
```

The smoke fails loudly on the exact defect class: `the close button has no click listener: the
panel script did not initialise`.

Run it whenever `src/panel.js`, `src/settingsPanel.ts`, `src/index.ts` or the build scripts
change, and before any release. A screenshot of a rendered panel is not evidence; only a click
that changes host state is.

The smoke sends the close click **fire-and-forget** and then polls the panel width. Awaiting the
`Runtime.evaluate` reply across the panel teardown crashed Joplin's renderer once
("Renderer process gone"): the frame (and its execution context) disappears before Chrome can
answer. Poll state instead of awaiting the click.

## Deploying a build to the Windows node

Joplin caches the extracted plugin and keys it by size/timestamp. A rebuilt `.jpl` can keep the
same size, so the old code may keep running while the archive is new. Deterministic sequence:

1. Quit Joplin (Ctrl+Q from the session-1 agent; confirm `Joplin.exe` count is 0).
2. Copy the `.jpl` over `<profile>/plugins/com.seigwen.dualtran.jpl` and verify SHA256.
3. Delete `<profile>/cache/com.seigwen.dualtran` **and** `<profile>/cache/plugin-extraction-state.json`.
4. Start Joplin with `--remote-debugging-port=9225`, then run the smoke over the tunnel.
5. Only then report the fix; attach the smoke output, not a screenshot.

## Environment hygiene

- The models.dev catalogue cache lives in the plugin data directory
  (`<profile>/plugin-data/com.seigwen.dualtran/catalog-cache.json`), not in `joplin.settings`.
  It used to be a ~6 MB settings value, which dominated the database size and is where corruption
  surfaced once. A legacy `catalogCache` setting is migrated to the file on first read and then
  cleared (the SQLite file keeps the freed pages until a VACUUM).
- Treat a corrupt `database.sqlite` as a data-recovery task (see the `dualtran-joplin` Hermes
  skill), not a plugin bug.
- Back up the profile before touching the database, and never edit it while Joplin is running.
