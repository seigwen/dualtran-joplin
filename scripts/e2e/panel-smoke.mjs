#!/usr/bin/env node
/**
 * Real-Joplin smoke test for the settings panel.
 *
 * The unit and jsdom tests prove the pieces; this proves the wiring inside the actual app,
 * which is where "the button renders but does nothing" lives: Joplin injects the panel script
 * asynchronously, the plugin then replaces the HTML, and a script that binds at the top level
 * can finish before `#dualtran` exists. The smoke therefore checks the *listener*, not the
 * button's presence, and does it again after a re-render.
 *
 * Usage:
 *   Joplin must be running with --remote-debugging-port=<port> (127.0.0.1) and the DualTran
 *   plugin enabled. Then:
 *
 *     node scripts/e2e/panel-smoke.mjs --port 9222
 *
 * Over an SSH tunnel: `ssh -N -L 9222:127.0.0.1:9222 <node>`, run this on the server.
 * Node 22+ ships a global WebSocket, so there is no dependency to install.
 */

const port = (() => {
  const index = process.argv.indexOf("--port");
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : "9222";
})();
const base = `http://127.0.0.1:${port}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CDP {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", (event) => reject(new Error(`CDP connect failed: ${event.message ?? "error"}`)), { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else resolve(message.result);
      } else if (message.method) {
        this.events.push(message);
      }
    });
  }

  /** Fire-and-forget: hiding the panel can destroy the frame mid-call, so the response may never come. */
  notify(method, params = {}) {
    this.ws.send(JSON.stringify({ id: this.nextId++, method, params }));
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout after 15s: ${method}`));
      }, 15000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

async function evaluate(cdp, expression, contextId) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    ...(contextId ? { contextId } : {}),
  });
  if (result.exceptionDetails) {
    throw new Error(`page error: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  }
  return result.result?.value;
}

async function findTargets() {
  const response = await fetch(`${base}/json/list`);
  if (!response.ok) throw new Error(`CDP list failed: HTTP ${response.status} on ${base}`);
  return response.json();
}

async function mainTarget() {
  const targets = await findTargets();
  const main = targets.find((target) => (target.url ?? "").includes("app.asar/index.html"));
  if (!main) throw new Error("Joplin main window not found. Start Joplin with --remote-debugging-port");
  return main;
}

async function pluginTarget() {
  const targets = await findTargets();
  const plugin = targets.find((target) => (target.url ?? "").includes("pluginId=com.seigwen.dualtran"));
  if (!plugin) throw new Error("DualTran plugin target not found; is the plugin enabled?");
  return plugin;
}

/** The panel's webview frame (Joplin renders panels through UserWebviewIndex.html). */
async function panelFrame(main) {
  const tree = await main.send("Page.getFrameTree");
  const stack = [tree.frameTree];
  while (stack.length) {
    const node = stack.pop();
    if ((node.frame.url ?? "").includes("UserWebviewIndex.html")) return node.frame;
    stack.push(...(node.childFrames ?? []));
  }
  throw new Error("panel webview frame not found; did the settings panel open?");
}

async function openPanel(plugin) {
  const ok = await evaluate(plugin, "joplin.commands.execute('dualtranOpenSettings').then(() => 'ok')");
  if (ok !== "ok") throw new Error(`dualtranOpenSettings failed: ${ok}`);
  await sleep(800);
}

async function panelState(main) {
  return main.send("Runtime.evaluate", {
    expression: `(() => {
      const item = document.querySelector('.rli-plugin-view-com\\\\.seigwen\\\\.dualtran-dualtranSettingsPanel');
      const frame = document.querySelector('iframe[id^=\\"plugin-view-com.seigwen.dualtran\\"]');
      const rect = (item ?? frame)?.getBoundingClientRect();
      return JSON.stringify({ present: Boolean(frame), width: rect ? Math.round(rect.width) : 0, height: rect ? Math.round(rect.height) : 0 });
    })()`,
    returnByValue: true,
  }).then((result) => JSON.parse(result.result.value));
}

async function checkHandlers(main) {
  const frame = await panelFrame(main);
  const world = await main.send("Page.createIsolatedWorld", { frameId: frame.id, worldName: "dualtran-smoke" });
  const contextId = world.executionContextId;
  const hasForm = await evaluate(main, "Boolean(document.getElementById('dualtran'))", contextId);
  if (!hasForm) throw new Error("panel DOM has no #dualtran form");
  const closeObject = await main.send("Runtime.evaluate", {
    expression: "document.getElementById('close')",
    contextId,
  });
  const objectId = closeObject.result?.objectId;
  if (!objectId) throw new Error("panel DOM has no #close button");
  const listeners = await main.send("DOMDebugger.getEventListeners", { objectId, depth: -1, pierce: true });
  const clicks = (listeners.listeners ?? []).filter((listener) => listener.type === "click");
  if (clicks.length === 0) {
    throw new Error("the close button has no click listener: the panel script did not initialise (the exact bug this smoke guards)");
  }
  if (clicks.length > 1) {
    throw new Error(`the close button has ${clicks.length} click listeners; the panel script double-bound`);
  }
  return contextId;
}

async function clickClose(main, contextId) {
  // Do not await the reply: the click hides the panel, which can tear down the frame (and its
  // execution context) before Chrome sends the Runtime.evaluate result.
  main.notify("Runtime.evaluate", { expression: "document.getElementById('close').click()", contextId });
  await sleep(900);
  const state = await panelState(main);
  if (state.present && state.width > 0) throw new Error(`close did not hide the panel: still ${state.width}x${state.height}`);
  return state;
}

async function run() {
  const plugin = new CDP((await pluginTarget()).webSocketDebuggerUrl);
  const main = new CDP((await mainTarget()).webSocketDebuggerUrl);
  await plugin.connect();
  await main.connect();
  await main.send("Page.enable");
  await main.send("Runtime.enable");

  console.log(`panel smoke: ${base}`);
  console.log("step  open panel");
  await openPanel(plugin);
  console.log("PASS  panel opens and renders #dualtran");

  console.log("step  check listeners");
  let contextId = await checkHandlers(main);
  console.log("PASS  close button has exactly one click listener");

  console.log("step  close");
  await clickClose(main, contextId);
  console.log("PASS  close hides the panel");

  // Re-open: this runs openSettingsPanel() again, i.e. another setHtml/re-render. A script that
  // only bound on first load loses the listener here.
  await openPanel(plugin);
  contextId = await checkHandlers(main);
  console.log("PASS  close button still armed after re-render");

  // And the control still works through the full round trip after the re-render.
  await clickClose(main, contextId);
  console.log("PASS  close still hides the panel after re-render");

  // Save posts a draft; the plugin re-renders; the close button must survive that too.
  await openPanel(plugin);
  contextId = await checkHandlers(main);
  await main.send("Runtime.evaluate", {
    expression: "document.getElementById('save').click()",
    contextId,
  });
  await sleep(800);
  contextId = await checkHandlers(main);
  await clickClose(main, contextId);
  console.log("PASS  close survives the save/re-render cycle");

  main.close();
  plugin.close();
  console.log("panel smoke: OK");
}

run().catch((error) => {
  console.error(`panel smoke: FAIL ${error.message}`);
  process.exitCode = 1;
});
