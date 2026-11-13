/* global webviewApi */
/**
 * Settings panel script, injected by `joplin.views.panels.addScript`.
 *
 * It owns no decisions: every change is posted to the plugin as `{action, draft}`, and the
 * plugin decides (which model to preselect, whether the endpoint is still autofilled), persists
 * and re-renders. That keeps the interesting logic in `src/settingsPanel.ts` where it is
 * unit-tested, and keeps this file small enough to read in one sitting.
 */
(function () {
  "use strict";

  var form = document.getElementById("dualtran");
  if (!form) return;

  var el = function (id) {
    return document.getElementById(id);
  };

  var post = function (payload) {
    // Older Joplin builds expose pluginApi without webviewApi; support both.
    if (typeof webviewApi !== "undefined" && webviewApi && webviewApi.postMessage) {
      webviewApi.postMessage(payload);
    } else if (typeof pluginApi !== "undefined" && pluginApi && pluginApi.postMessage) {
      pluginApi.postMessage(payload);
    }
  };

  var status = el("status");
  var setStatus = function (text) {
    if (status) status.textContent = text || "";
  };

  /** Everything the user currently sees, in the shape `PanelDraft` expects. */
  function draft() {
    var custom = el("customModel");
    var endpoint = el("endpoint");
    return {
      engine: el("engine") ? el("engine").value : undefined,
      language: el("target").value,
      provider: el("provider").value,
      model: el("model").value,
      customModel: custom ? custom.value : "",
      endpoint: endpoint.value,
      endpointCustom: endpoint.getAttribute("data-custom") === "true",
      apiKey: el("apiKey").value,
      reasoning: el("reasoning").value,
    };
  }

  function send(action) {
    post({ action: action, draft: draft() });
  }

  // Provider, model and endpoint changes are decisions only the plugin can make (which model to
  // preselect, whether the endpoint is still autofilled), so they go back to it as a save of the
  // current draft; the plugin re-renders with the corrected state.
  el("provider").addEventListener("change", function () {
    send("save");
  });

  el("endpoint").addEventListener("input", function () {
    var field = el("endpoint");
    // Once the user touches the field it is theirs; the flag travels with the next save.
    field.setAttribute("data-custom", field.value.trim() ? "true" : "false");
  });

  el("model").addEventListener("change", function () {
    var custom = el("customModel");
    if (custom) {
      var isCustom = el("model").value === "__custom__";
      custom.hidden = !isCustom;
      if (isCustom) custom.focus();
    }
    send("save");
  });

  if (el("customModel")) {
    el("customModel").addEventListener("input", function () {
      send("save");
    });
  }

  el("reasoning").addEventListener("change", function () {
    send("save");
  });

  el("save").addEventListener("click", function () {
    setStatus("…");
    send("save");
  });

  el("refresh").addEventListener("click", function () {
    setStatus("…");
    send("refresh");
  });

  el("close").addEventListener("click", function () {
    post({ action: "close" });
  });
})();
