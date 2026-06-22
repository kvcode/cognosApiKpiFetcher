define([], function () {
  "use strict";

  // ═══════════════════════════════════════════════════════════════════════════
  // preLoadApiKpiFetcher.js  (generic bootstrapper, same pattern as apiFetcher)
  //
  // Lives on the Cognos server (e.g. /cognos4/samples/javascript/apiKpiFetcher/)
  // and is the only file Cognos references directly. It loads the real module
  // (apiKpiFetcher.js) and its CSS from the URLs in config.json, then forwards
  // every CustomControl lifecycle call to the loaded module.
  //
  // config.json keys it reads:
  //   BaseScriptPaths.MainLoader  -> apiKpiFetcher.js  (jsDelivr / GitHub Pages)
  //   BaseScriptPaths.MainCSS     -> styleApiKpiFetcher.css  (string OR array)
  //   version                     -> optional, logged for debug tracing
  //
  // NOTE: ListRenderer / ChartRenderer URLs are loaded by apiKpiFetcher.js
  // itself (it require()s them in initialize()), not here.
  // ═══════════════════════════════════════════════════════════════════════════

  function PreLoad() {
    console.log("[PreLoadKpi] Constructor called");
    this.control = null;
  }

  // ── INITIALIZE ──────────────────────────────────────────────────────────
  PreLoad.prototype.initialize = function (oControlHost, fnDoneInitializing) {
    console.log("[PreLoadKpi] initialize() called");

    var config = oControlHost.configuration || {};
    var basePaths = config.BaseScriptPaths || {};
    var fallbackBase = config.BaseScriptPath || "/cognos4/samples/javascript/apiKpiFetcher/";

    if (config.version) console.log("[PreLoadKpi] Module version:", config.version);

    // CSS — single string or array of stylesheet URLs/paths.
    var cssEntry = basePaths.MainCSS || fallbackBase + "styleApiKpiFetcher.css";
    var cssUrls = Array.isArray(cssEntry) ? cssEntry : [cssEntry];
    for (var i = 0; i < cssUrls.length; i++) this.injectCSS(cssUrls[i]);

    // Main module.
    var mainLoaderPath = basePaths.MainLoader || fallbackBase + "apiKpiFetcher.js";
    console.log("[PreLoadKpi] Loading MainLoader from:", mainLoaderPath);

    var self = this;
    require(
      [mainLoaderPath],
      function (LoadedModule) {
        console.log("[PreLoadKpi] OK MainLoader module loaded");
        try {
          self.control = new LoadedModule();
          if (typeof self.control.initialize === "function") {
            self.control.initialize(oControlHost, fnDoneInitializing);
          } else {
            console.warn("[PreLoadKpi] WARN loaded module has no initialize() - skipping");
            fnDoneInitializing();
          }
        } catch (err) {
          console.error("[PreLoadKpi] ERR instantiating loaded module:", err);
          fnDoneInitializing();
        }
      },
      function (err) {
        console.error("[PreLoadKpi] ERR failed to load MainLoader from:", mainLoaderPath, err);
        fnDoneInitializing();
      }
    );
  };

  // ── CSS INJECTION ───────────────────────────────────────────────────────
  // External URLs -> <link>; local paths -> RequireJS text plugin.
  PreLoad.prototype.injectCSS = function (cssUrl) {
    if (!cssUrl) return;
    try {
      if (/^https?:\/\//i.test(cssUrl)) {
        var link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = cssUrl;
        link.type = "text/css";
        document.head.appendChild(link);
        console.log("[PreLoadKpi] OK external CSS linked:", cssUrl);
        return;
      }
      require(
        ["text!" + cssUrl],
        function (cssContent) {
          var style = document.createElement("style");
          style.textContent = cssContent;
          document.head.appendChild(style);
          console.log("[PreLoadKpi] OK local CSS injected:", cssUrl);
        },
        function (err) {
          console.error("[PreLoadKpi] ERR failed to load local CSS:", cssUrl, err);
        }
      );
    } catch (e) {
      console.error("[PreLoadKpi] ERR CSS injection error:", cssUrl, e);
    }
  };

  // ── LIFECYCLE DELEGATION (pure pass-through) ──────────────────────────────
  PreLoad.prototype.draw = function (oControlHost) {
    console.log("[PreLoadKpi] draw() called");
    if (this.control && typeof this.control.draw === "function") {
      this.control.draw(oControlHost);
    } else {
      console.warn("[PreLoadKpi] WARN draw() skipped - module not ready");
    }
  };

  PreLoad.prototype.setData = function (oControlHost, oDataStore) {
    console.log("[PreLoadKpi] setData() called - dataStore:", oDataStore ? oDataStore.name : "null");
    if (this.control && typeof this.control.setData === "function") {
      this.control.setData(oControlHost, oDataStore);
    } else {
      console.warn("[PreLoadKpi] WARN setData() skipped - module not ready");
    }
  };

  // Report-page control: implemented so Cognos never crashes calling them,
  // but they return null / true (no prompt parameters here).
  PreLoad.prototype.getParameters = function (oControlHost) {
    if (this.control && typeof this.control.getParameters === "function") {
      return this.control.getParameters(oControlHost);
    }
    return null;
  };

  PreLoad.prototype.isInValidState = function (oControlHost) {
    if (this.control && typeof this.control.isInValidState === "function") {
      return this.control.isInValidState(oControlHost);
    }
    return true;
  };

  PreLoad.prototype.destroy = function (oControlHost) {
    console.log("[PreLoadKpi] destroy() called");
    if (this.control && typeof this.control.destroy === "function") {
      this.control.destroy(oControlHost);
    }
    this.control = null;
  };

  return PreLoad;
});
