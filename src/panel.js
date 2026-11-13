/* global webviewApi */
/**
 * Settings panel script, injected by `joplin.views.panels.addScript`.
 *
 * It owns no decisions: every change is posted to the plugin as `{action, draft}`, and the
 * plugin decides (which model to preselect, whether the endpoint is still autofilled), persists
 * and re-renders. That keeps the interesting logic in `src/settingsPanel.ts` where it is
 * Joplin loads this script asynchronously into the panel webview and only then does the plugin
 * call `setHtml`, so the script can run before `#dualtran` exists (or the HTML can be replaced
 * without a reload). Binding at the top level and bailing out when the form is missing leaves
 * every control dead: the panel renders, but its buttons post nothing. Bind through `init()`
 * and let the document / a mutation observer call it when the form actually appears.
 */
(function () {
  "use strict";

  function init() {
    var form = document.getElementById("dualtran");
    if (!form) return false;
    // A second evaluation (addScript plus a script tag, or a re-render) must not double-bind:
    // two listeners turn one click into two messages.
    if (form.getAttribute("data-dualtran-ready") === "true") return true;
    form.setAttribute("data-dualtran-ready", "true");

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

    return true;
  }

  if (init()) return;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  }
  // `setHtml` replaces the panel content with `innerHTML`, so the panel script is *not*
  // re-executed on a re-render: the observer must stay installed and rebind the new form.
  if (typeof MutationObserver !== "undefined" && document.documentElement) {
    var observer = new MutationObserver(function () {
      init();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
