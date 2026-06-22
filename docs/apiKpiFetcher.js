define([], function () {
  "use strict";

  // ═══════════════════════════════════════════════════════════════════════════
  // apiKpiFetcher.js — orchestrator for the FFP SF1000 KPI control
  //
  // Flow:
  //   setData()  -> cache the DataStore named in config.kpiDataStore
  //   draw()     -> validate dataMap vs DataStore (RED block on mismatch),
  //                 render toolbar (ENV + Aggregation dropdowns, Auth, Load,
  //                 Copy JSON, Copy Table), restore any cached token
  //   Auth btn   -> OAuth2 PKCE popup (reused verbatim from apiFetcher)
  //   Load btn   -> scan distinct dimension values, build repeated-key query,
  //                 POST, parse, render pivot via listRenderer, show banners
  //
  // No corporate URLs / client IDs are hardcoded — all from oControlHost.configuration.
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("[ApiKpiFetcher] === Module Loaded ===");

  // Static API structure map — the response array each aggregation populates,
  // and the field inside each item that carries the dimension value.
  // This is the FFP API's own shape, not business logic, so it lives in code.
  var AGG_ARRAY_KEY = {
    production_month: "production_months",
    brand_2_digit: "brand_2_digits",
    production_year: "production_years",
    modell_year: "modell_years",
    car_plant: "car_plants",
    iso3_del: "iso3_dels",
  };

  function ApiKpiFetcher() {
    this.m_oControlHost = null;
    this.config = {};
    this.domNode = null;
    this.dataStores = {};
    this.kpiStore = null;

    this.ListRenderer = null;
    this.ChartRenderer = null;
    this.listRenderer = null;

    this.locale = "en";
    this.lastResponse = null;
    this.lastTableText = "";

    // OAuth state
    this.oauthToken = null;
    this.oauthTokenExpiry = null;
    this.oauthPopup = null;
    this.oauthState = null;
    this.oauthNonce = null;
    this.codeVerifier = null;
    this.messageHandler = null;
  }

  // ═══════════════════════ LIFECYCLE ═══════════════════════
  ApiKpiFetcher.prototype.initialize = function (oControlHost, fnDoneInitializing) {
    this.m_oControlHost = oControlHost;
    this.config = oControlHost.configuration || {};
    this.locale = this._resolveLocale(oControlHost);

    var self = this;
    var paths = this.config.BaseScriptPaths || {};
    var toLoad = [];
    var idx = {};
    if (paths.ListRenderer) {
      idx.list = toLoad.length;
      toLoad.push(paths.ListRenderer);
    }
    if (paths.ChartRenderer) {
      idx.chart = toLoad.length;
      toLoad.push(paths.ChartRenderer);
    }

    if (!toLoad.length) {
      console.warn("[ApiKpiFetcher] No renderer paths in config.BaseScriptPaths");
      fnDoneInitializing();
      return;
    }

    require(
      toLoad,
      function () {
        var a = arguments;
        if (idx.list !== undefined) self.ListRenderer = a[idx.list];
        if (idx.chart !== undefined) self.ChartRenderer = a[idx.chart];
        console.log("[ApiKpiFetcher] Renderers loaded — list:", !!self.ListRenderer, "chart:", !!self.ChartRenderer);
        fnDoneInitializing();
      },
      function (err) {
        console.error("[ApiKpiFetcher] Failed to load renderers:", err);
        fnDoneInitializing();
      }
    );
  };

  ApiKpiFetcher.prototype.setData = function (oControlHost, oDataStore) {
    if (!oDataStore) return;
    this.dataStores[oDataStore.name] = oDataStore;
    var target = this.config.kpiDataStore || "FFP_Dimensions";
    if (oDataStore.name === target) {
      this.kpiStore = oDataStore;
      console.log("[ApiKpiFetcher] KPI DataStore cached:", oDataStore.name, "rows:", oDataStore.rowCount);
    }
  };

  ApiKpiFetcher.prototype.draw = function (oControlHost) {
    this.m_oControlHost = oControlHost;
    this.config = oControlHost.configuration || this.config;
    this.locale = this._resolveLocale(oControlHost);

    oControlHost.container.innerHTML = "";
    this.domNode = document.createElement("div");
    this.domNode.className = "ffp-kpi-ctrl";
    oControlHost.container.appendChild(this.domNode);

    // Validate mapping first — fatal config errors short-circuit to a RED block.
    var problems = this._validateMapping();
    if (problems) {
      this.domNode.innerHTML = this._buildErrorBlock(problems);
      return;
    }

    this.domNode.innerHTML = this._buildHTML();
    this._populateDropdowns();
    this._bindEvents();
    this._restoreToken();
  };

  // ═══════════════════════ VALIDATION ═══════════════════════
  ApiKpiFetcher.prototype._validateMapping = function () {
    var msgs = [];
    if (!this.kpiStore) {
      msgs.push(
        'DataStore "<code>' +
          (this.config.kpiDataStore || "FFP_Dimensions") +
          '</code>" was not received. Check the DataStore name on the data set feeding this control.'
      );
      return msgs;
    }
    var cols = this.kpiStore.columnNames || [];
    var map = this.config.dataMap || [];
    if (!map.length) {
      msgs.push("<code>dataMap</code> is empty in the configuration.");
      return msgs;
    }
    // Every mapped column must exist in the DataStore.
    for (var i = 0; i < map.length; i++) {
      if (cols.indexOf(map[i].columnName) === -1) {
        msgs.push(
          'dataMap column "<code>' +
            this._esc(map[i].columnName) +
            '</code>" (apiParam <code>' +
            this._esc(map[i].apiParam) +
            "</code>) is not present in the DataStore. Add it to the data set, or remove it from dataMap."
        );
      }
    }
    // Exactly one MIS column is required (it drives the pivot columns).
    var misEntries = map.filter(function (m) {
      return m.role === "mis";
    });
    if (misEntries.length === 0) {
      msgs.push('No MIS column mapped. One dataMap entry must have <code>"role": "mis"</code>.');
    } else if (misEntries.length > 1) {
      msgs.push("More than one MIS column mapped — only one <code>role: \"mis\"</code> is allowed.");
    }
    return msgs.length ? msgs : null;
  };

  // ═══════════════════════ HTML ═══════════════════════
  ApiKpiFetcher.prototype._buildHTML = function () {
    var btn = (this.config.buttons && this.config.buttons[0]) || {};
    var loadLabel = this._lbl(btn.labels) || "Load KPI";
    return [
      '<div class="fk-wrapper">',

      '<div class="fk-panel">',
      '<div class="fk-panel-header">',
      '  <h3 class="fk-panel-title">FFP SF1000 KPI</h3>',
      '  <span class="fk-subtitle">damage cases / 1000</span>',
      '  <span class="fk-badge" id="fk-token-badge">No Token</span>',
      "</div>",
      '<div class="fk-panel-body">',

      '<div class="fk-toolbar">',
      '  <div class="fk-field"><span class="fk-lbl">Environment</span><select id="fk-env" class="fk-sel"></select></div>',
      '  <div class="fk-field"><span class="fk-lbl">Aggregation</span><select id="fk-agg" class="fk-sel"></select></div>',
      "</div>",

      '<div class="fk-btns">',
      '  <button id="fk-btn-auth" class="fk-btn fk-btn-p">1. Authenticate</button>',
      '  <button id="fk-btn-load" class="fk-btn fk-btn-p" disabled>2. ' + this._esc(loadLabel) + "</button>",
      '  <button id="fk-btn-copy-json" class="fk-btn fk-btn-s" disabled>Copy JSON</button>',
      '  <button id="fk-btn-copy-table" class="fk-btn fk-btn-s" disabled>Copy Table</button>',
      '  <button id="fk-btn-clear-token" class="fk-btn fk-btn-n">Clear Token</button>',
      "</div>",

      '<div id="fk-status" class="fk-status fk-hidden"></div>',
      "</div></div>",

      // scope + granularity + table + raw json
      '<div id="fk-banner" class="fk-hidden"></div>',
      '<div id="fk-warn" class="fk-hidden"></div>',
      '<div id="fk-table"></div>',

      '<div id="fk-raw-section" class="fk-hidden">',
      '  <div class="fk-raw-hdr" id="fk-raw-toggle"><span id="fk-raw-arrow">\u25B6</span> Raw API response (JSON)</div>',
      '  <pre id="fk-raw" class="fk-pre fk-hidden"></pre>',
      "</div>",

      "</div>",
    ].join("\n");
  };

  ApiKpiFetcher.prototype._buildErrorBlock = function (msgs) {
    var items = msgs
      .map(function (m) {
        return "<li>" + m + "</li>";
      })
      .join("");
    return [
      '<div class="fk-wrapper"><div class="fk-error-block">',
      "<h4>\u26D4 KPI control cannot render — configuration / data mismatch</h4>",
      "<ul>" + items + "</ul>",
      "</div></div>",
    ].join("\n");
  };

  // ═══════════════════════ DROPDOWNS ═══════════════════════
  ApiKpiFetcher.prototype._populateDropdowns = function () {
    var self = this;

    // Environment — keys from config.api.environments, like the PBI connector.
    var api = this.config.api || {};
    var envs = api.environments || {};
    var envSel = this.domNode.querySelector("#fk-env");
    Object.keys(envs).forEach(function (k) {
      var o = document.createElement("option");
      o.value = k;
      o.textContent = k;
      envSel.appendChild(o);
    });
    if (api.defaultEnvironment && envs[api.defaultEnvironment] !== undefined) {
      envSel.value = api.defaultEnvironment;
    }

    // Aggregation — from config.aggregations (value + localized labels).
    var aggSel = this.domNode.querySelector("#fk-agg");
    var aggs = this.config.aggregations || [{ value: "production_month", labels: { en: "Production Month" } }];
    aggs.forEach(function (a) {
      // Only offer aggregations the API actually supports (have an array key).
      if (!AGG_ARRAY_KEY[a.value]) return;
      var o = document.createElement("option");
      o.value = a.value;
      o.textContent = self._lbl(a.labels) || a.value;
      aggSel.appendChild(o);
    });
  };

  // ═══════════════════════ EVENTS ═══════════════════════
  ApiKpiFetcher.prototype._bindEvents = function () {
    var self = this,
      R = this.domNode;
    R.querySelector("#fk-btn-auth").addEventListener("click", function () {
      self._startOAuth();
    });
    R.querySelector("#fk-btn-load").addEventListener("click", function () {
      self._doLoad();
    });
    R.querySelector("#fk-btn-copy-json").addEventListener("click", function () {
      self._copy(JSON.stringify(self.lastResponse, null, 2), "JSON");
    });
    R.querySelector("#fk-btn-copy-table").addEventListener("click", function () {
      self._copy(self.lastTableText, "Table");
    });
    R.querySelector("#fk-btn-clear-token").addEventListener("click", function () {
      self._clearToken();
    });
    R.querySelector("#fk-raw-toggle").addEventListener("click", function () {
      var pre = R.querySelector("#fk-raw"),
        arr = R.querySelector("#fk-raw-arrow");
      var hidden = pre.classList.toggle("fk-hidden");
      arr.textContent = hidden ? "\u25B6" : "\u25BC";
    });

    this.messageHandler = function (ev) {
      self._onOAuthMessage(ev);
    };
    window.addEventListener("message", this.messageHandler);
  };

  // ═══════════════════════ DISTINCT SCAN ═══════════════════════
  ApiKpiFetcher.prototype._distinct = function (columnName) {
    var ds = this.kpiStore;
    var ci = (ds.columnNames || []).indexOf(columnName);
    if (ci === -1) return [];
    var seen = {},
      out = [];
    for (var r = 0; r < ds.rowCount; r++) {
      var v = ds.getCellValue(r, ci);
      if (v === null || v === undefined || v === "") continue;
      var key = String(v);
      if (!seen[key]) {
        seen[key] = true;
        out.push(v);
      }
    }
    return out;
  };

  // ═══════════════════════ REQUEST BUILD ═══════════════════════
  ApiKpiFetcher.prototype._buildUrl = function (aggregation) {
    var api = this.config.api || {};
    var btn = (this.config.buttons && this.config.buttons[0]) || {};
    var env = this.domNode.querySelector("#fk-env").value;
    var infix = (api.environments || {})[env] || "";
    var base = (api.baseUrlTemplate || "").replace("{env}", infix);
    var endpoint = btn.endpoint || "";

    var params = new URLSearchParams();
    params.append("aggregation", aggregation);

    var map = this.config.dataMap || [];
    var misCol = map.filter(function (m) {
      return m.role === "mis";
    })[0];

    // MIS — distinct values from the mapped MIS column.
    var self = this;
    this._distinct(misCol.columnName).forEach(function (v) {
      params.append("mis", v);
    });

    // Filters — every other mapped column, distinct values, repeated keys.
    map.forEach(function (m) {
      if (m.role === "mis") return;
      self._distinct(m.columnName).forEach(function (v) {
        params.append(m.apiParam, v);
      });
    });

    return base + endpoint + "?" + params.toString();
  };

  // ═══════════════════════ BANNERS ═══════════════════════
  ApiKpiFetcher.prototype._buildBanner = function (aggregation) {
    var self = this,
      map = this.config.dataMap || [];
    var parts = [];

    // Aggregation + MIS first.
    var aggLabel = this._aggLabel(aggregation);
    var misCol = map.filter(function (m) {
      return m.role === "mis";
    })[0];
    var misVals = this._distinct(misCol.columnName)
      .map(Number)
      .sort(function (a, b) {
        return a - b;
      });
    parts.push("<strong>Aggregation:</strong> " + this._esc(aggLabel));
    parts.push("<strong>MIS:</strong> " + this._esc(misVals.join(", ")));

    // Filters (skip the column acting as the aggregation row dimension).
    map.forEach(function (m) {
      if (m.role === "mis") return;
      if (m.apiParam === aggregation) return;
      var vals = self._distinct(m.columnName);
      if (!vals.length) return;
      parts.push("<strong>" + self._esc(self._lbl(m.labels) || m.apiParam) + ":</strong> " + self._esc(vals.join(", ")));
    });

    return '<div class="fk-banner">' + parts.join(" &nbsp;|&nbsp; ") + "</div>";
  };

  // Yellow warning when a non-aggregation filter has >1 distinct value:
  // the API aggregates across those values, so the KPI is a sum over them
  // (mimics Cognos' sum-on-broken-granularity behaviour).
  ApiKpiFetcher.prototype._buildGranularityWarning = function (aggregation) {
    var self = this,
      map = this.config.dataMap || [];
    var offenders = [];
    map.forEach(function (m) {
      if (m.role === "mis") return;
      if (m.apiParam === aggregation) return;
      var vals = self._distinct(m.columnName);
      if (vals.length > 1) {
        offenders.push((self._lbl(m.labels) || m.apiParam) + " (" + vals.length + ")");
      }
    });
    if (!offenders.length) return null;
    return (
      '<div class="fk-warn"><strong>\u26A0 Granularity note:</strong> the KPI is aggregated across multiple values of ' +
      this._esc(offenders.join(", ")) +
      ". Each cell is the combined figure for the whole scope above, not a per-value breakdown. " +
      "To break a dimension out per row, set it as the Aggregation, or scope the report to a single value.</div>"
    );
  };

  // ═══════════════════════ LOAD / FETCH ═══════════════════════
  ApiKpiFetcher.prototype._doLoad = function () {
    var self = this;
    if (!this.oauthToken) {
      this._status("Authenticate first (button 1).", "error");
      return;
    }
    var aggregation = this.domNode.querySelector("#fk-agg").value;
    var arrayKey = AGG_ARRAY_KEY[aggregation];
    if (!arrayKey) {
      this._status("Unsupported aggregation: " + aggregation, "error");
      return;
    }
    var url = this._buildUrl(aggregation);
    var api = this.config.api || {};
    var accept = api.acceptHeader || "application/json";

    console.log("[ApiKpiFetcher] POST", url);
    this._status("Loading " + aggregation + " \u2026", "loading");

    var t0 = performance.now();
    fetch(url, {
      method: "POST",
      mode: "cors",
      headers: {
        Authorization: "Bearer " + this.oauthToken,
        Accept: accept,
        "Content-Type": "application/json",
      },
      body: "", // empty body forces POST; all params are in the query string
    })
      .then(function (r) {
        return r.text().then(function (t) {
          return { status: r.status, statusText: r.statusText, text: t };
        });
      })
      .then(function (res) {
        if (self.m_oControlHost && self.m_oControlHost.isDestroyed) return;
        var ms = Math.round(performance.now() - t0);
        var json = null;
        try {
          json = JSON.parse(res.text);
        } catch (e) {
          json = null;
        }

        if (res.status >= 200 && res.status < 300 && json) {
          self.lastResponse = json;
          self._renderAll(json, aggregation, arrayKey);
          self._status("Loaded \u2014 HTTP " + res.status + " \u2014 " + ms + "ms", "success");
        } else if (res.status === 401 || res.status === 403) {
          self._status(
            "HTTP " + res.status + " \u2014 token rejected (missing KIRA roles / aud?). Re-authenticate or check CloudIDP mapper.",
            "error"
          );
          self._showRaw(res.text);
        } else {
          self._status("HTTP " + res.status + " " + (res.statusText || "") + " \u2014 see raw response.", "error");
          self._showRaw(res.text);
        }
      })
      .catch(function (err) {
        if (self.m_oControlHost && self.m_oControlHost.isDestroyed) return;
        self._status("FAILED: " + err.message + " (CORS / network?)", "error");
      });
  };

  ApiKpiFetcher.prototype._renderAll = function (json, aggregation, arrayKey) {
    var btn = (this.config.buttons && this.config.buttons[0]) || {};

    // Banner + granularity warning
    var banner = this.domNode.querySelector("#fk-banner");
    banner.innerHTML = this._buildBanner(aggregation);
    banner.classList.remove("fk-hidden");

    var warn = this.domNode.querySelector("#fk-warn");
    var w = this._buildGranularityWarning(aggregation);
    if (w) {
      warn.innerHTML = w;
      warn.classList.remove("fk-hidden");
    } else {
      warn.classList.add("fk-hidden");
      warn.innerHTML = "";
    }

    // Pivot table
    if (!this.listRenderer && this.ListRenderer) this.listRenderer = new this.ListRenderer();
    var tableEl = this.domNode.querySelector("#fk-table");
    var out = { tableText: "" };
    if (this.listRenderer) {
      out = this.listRenderer.render(tableEl, {
        response: json,
        aggParam: aggregation,
        aggArrayKey: arrayKey,
        rowHeaderLabel: this._aggLabel(aggregation),
        kpiLabel: this._lbl(btn.kpiColumnLabel) || "SF1000",
        deltaThresholds: btn.deltaThresholds || {},
      });
    } else {
      tableEl.innerHTML = '<div class="fk-warn">List renderer not loaded.</div>';
    }
    this.lastTableText = out.tableText || "";

    // Raw JSON
    this._showRaw(JSON.stringify(json, null, 2));

    // Enable copy buttons
    this.domNode.querySelector("#fk-btn-copy-json").disabled = false;
    this.domNode.querySelector("#fk-btn-copy-table").disabled = !this.lastTableText;
  };

  ApiKpiFetcher.prototype._showRaw = function (text) {
    var sec = this.domNode.querySelector("#fk-raw-section");
    this.domNode.querySelector("#fk-raw").textContent = text;
    sec.classList.remove("fk-hidden");
  };

  // ═══════════════════════ COPY ═══════════════════════
  ApiKpiFetcher.prototype._copy = function (text, what) {
    var self = this;
    if (!text) {
      this._status("Nothing to copy for " + what, "error");
      return;
    }
    var done = function () {
      self._status("\u2705 " + what + " copied to clipboard", "success");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        self._fallbackCopy(text, done);
      });
    } else {
      this._fallbackCopy(text, done);
    }
  };
  ApiKpiFetcher.prototype._fallbackCopy = function (text, done) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      done();
    } catch (e) {
      this._status("Copy failed — select the raw panel manually.", "error");
    }
    document.body.removeChild(ta);
  };

  // ═══════════════════════ OAUTH2 PKCE (reused from apiFetcher) ═══════════════════════
  ApiKpiFetcher.prototype._startOAuth = function () {
    var self = this;
    var op = this.config.oauthPreset || {};
    var authUrl = op.authorizeUrl,
      clientId = op.clientId,
      redirect = this.config.callbackUrl,
      scope = op.scope || "openid",
      method = "S256";

    if (!authUrl || !clientId || !redirect) {
      this._status("Missing oauthPreset.authorizeUrl / clientId / callbackUrl in config.", "error");
      return;
    }
    this._status("Generating PKCE \u2026", "loading");

    this._genPKCE(method)
      .then(function (pkce) {
        self.codeVerifier = pkce.verifier;
        var nonce = self._rnd(32);
        self.oauthNonce = nonce;
        var statePayload = { nonce: nonce };
        if (self.config.callbackScriptUrl) statePayload.scriptUrl = self.config.callbackScriptUrl;
        self.oauthState = btoa(JSON.stringify(statePayload));

        var url =
          authUrl +
          "?" +
          [
            "client_id=" + encodeURIComponent(clientId),
            "response_type=code",
            "redirect_uri=" + encodeURIComponent(redirect),
            "scope=" + encodeURIComponent(scope),
            "state=" + encodeURIComponent(self.oauthState),
            "code_challenge=" + encodeURIComponent(pkce.challenge),
            "code_challenge_method=" + encodeURIComponent(method),
          ].join("&");

        self.oauthPopup = window.open(url, "ffp_kpi_oauth", "width=720,height=820,scrollbars=yes");
        if (!self.oauthPopup || self.oauthPopup.closed) {
          self._status("Popup blocked — allow popups for this site.", "error");
          return;
        }
        self._status("Waiting for login in popup \u2026", "loading");
        var poll = setInterval(function () {
          if (self.oauthPopup && self.oauthPopup.closed) {
            clearInterval(poll);
            if (!self.oauthToken) self._status("Popup closed without login.", "error");
          }
        }, 1000);
      })
      .catch(function (err) {
        self._status("PKCE failed: " + err.message, "error");
      });
  };

  ApiKpiFetcher.prototype._onOAuthMessage = function (ev) {
    if (!ev.data || ev.data.type !== "oauth2_callback") return;
    if (ev.data.error) {
      this._status(ev.data.error + (ev.data.error_description ? ": " + ev.data.error_description : ""), "error");
      return;
    }
    if (ev.data.code) {
      if (this.oauthNonce && ev.data.state && ev.data.state !== this.oauthNonce) {
        this._status("OAuth state mismatch — aborted.", "error");
        return;
      }
      this._status("Code received, exchanging for token \u2026", "loading");
      this._exchangeToken(ev.data.code);
    }
  };

  ApiKpiFetcher.prototype._exchangeToken = function (code) {
    var self = this,
      op = this.config.oauthPreset || {};
    var tokenUrl = op.tokenUrl,
      clientId = op.clientId,
      redirect = this.config.callbackUrl;
    if (!tokenUrl) {
      this._status("Missing oauthPreset.tokenUrl in config.", "error");
      return;
    }
    var body = [
      "grant_type=authorization_code",
      "client_id=" + encodeURIComponent(clientId),
      "code=" + encodeURIComponent(code),
      "redirect_uri=" + encodeURIComponent(redirect),
      "code_verifier=" + encodeURIComponent(this.codeVerifier),
    ].join("&");

    fetch(tokenUrl, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body,
    })
      .then(function (r) {
        return r.text().then(function (t) {
          return { status: r.status, text: t };
        });
      })
      .then(function (res) {
        if (self.m_oControlHost && self.m_oControlHost.isDestroyed) return;
        var j = null;
        try {
          j = JSON.parse(res.text);
        } catch (e) {}
        if (j && j.access_token) {
          self.oauthToken = j.access_token;
          self.oauthTokenExpiry = j.expires_in ? Date.now() + j.expires_in * 1000 : null;
          self._storeToken();
          self._markAuthed();
          self._status(
            "\u2705 Authenticated" + (self.oauthTokenExpiry ? " (expires " + new Date(self.oauthTokenExpiry).toLocaleTimeString() + ")" : ""),
            "success"
          );
        } else if (j && j.error) {
          self._status(j.error + (j.error_description ? " - " + j.error_description : ""), "error");
        } else {
          self._status("Token exchange failed — HTTP " + res.status, "error");
          self._showRaw(res.text);
        }
      })
      .catch(function (e) {
        self._status("Token exchange error: " + e.message + " (CORS?)", "error");
      });
  };

  ApiKpiFetcher.prototype._genPKCE = function (m) {
    var v = this._rnd(64);
    if (m === "plain") return Promise.resolve({ verifier: v, challenge: v });
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)).then(function (h) {
      var b = new Uint8Array(h),
        s = "";
      for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      return { verifier: v, challenge: btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") };
    });
  };
  ApiKpiFetcher.prototype._rnd = function (n) {
    var c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~",
      a = new Uint8Array(n);
    crypto.getRandomValues(a);
    var r = "";
    for (var i = 0; i < n; i++) r += c[a[i] % c.length];
    return r;
  };

  // ═══════════════════════ TOKEN PERSISTENCE (shared key for multi-CC reuse) ═══════════════════════
  ApiKpiFetcher.prototype._tokenKey = function () {
    return this.config.tokenStorageKey || "ffp_kpi_oauth_token";
  };
  ApiKpiFetcher.prototype._storeToken = function () {
    try {
      sessionStorage.setItem(
        this._tokenKey(),
        JSON.stringify({ token: this.oauthToken, expiry: this.oauthTokenExpiry })
      );
    } catch (e) {}
  };
  ApiKpiFetcher.prototype._restoreToken = function () {
    try {
      var raw = sessionStorage.getItem(this._tokenKey());
      if (!raw) return;
      var o = JSON.parse(raw);
      if (o && o.token && (!o.expiry || o.expiry > Date.now() + 5000)) {
        this.oauthToken = o.token;
        this.oauthTokenExpiry = o.expiry;
        this._markAuthed();
        this._status("Reusing cached token from this session.", "success");
      } else {
        sessionStorage.removeItem(this._tokenKey());
      }
    } catch (e) {}
  };
  ApiKpiFetcher.prototype._markAuthed = function () {
    var badge = this.domNode.querySelector("#fk-token-badge");
    if (badge) {
      badge.textContent = "\u2705 Active";
      badge.className = "fk-badge fk-badge-ok";
    }
    var load = this.domNode.querySelector("#fk-btn-load");
    if (load) load.disabled = false;
    var auth = this.domNode.querySelector("#fk-btn-auth");
    if (auth) auth.textContent = "1. Re-authenticate";
  };
  ApiKpiFetcher.prototype._clearToken = function () {
    this.oauthToken = null;
    this.oauthTokenExpiry = null;
    this.codeVerifier = null;
    try {
      sessionStorage.removeItem(this._tokenKey());
    } catch (e) {}
    var badge = this.domNode.querySelector("#fk-token-badge");
    if (badge) {
      badge.textContent = "No Token";
      badge.className = "fk-badge";
    }
    this.domNode.querySelector("#fk-btn-load").disabled = true;
    this.domNode.querySelector("#fk-btn-auth").textContent = "1. Authenticate";
    this._status("Token cleared.", "loading");
  };

  // ═══════════════════════ HELPERS ═══════════════════════
  ApiKpiFetcher.prototype._resolveLocale = function (host) {
    var loc = (host && host.locale ? host.locale : "en").toLowerCase();
    return loc.indexOf("de") === 0 ? "de" : "en"; // only DE/EN; everything else -> EN
  };
  ApiKpiFetcher.prototype._lbl = function (obj) {
    if (!obj) return "";
    return obj[this.locale] || obj.en || "";
  };
  ApiKpiFetcher.prototype._aggLabel = function (value) {
    var aggs = this.config.aggregations || [];
    for (var i = 0; i < aggs.length; i++) {
      if (aggs[i].value === value) return this._lbl(aggs[i].labels) || value;
    }
    return value;
  };
  ApiKpiFetcher.prototype._status = function (msg, type) {
    var el = this.domNode.querySelector("#fk-status");
    if (!el) return;
    el.textContent = msg;
    el.className = "fk-status fk-status-" + type;
  };
  ApiKpiFetcher.prototype._esc = function (s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  };

  // ═══════════════════════ COGNOS LIFECYCLE ═══════════════════════
  ApiKpiFetcher.prototype.getParameters = function () {
    return null; // report-page control — no prompt parameters
  };
  ApiKpiFetcher.prototype.isInValidState = function () {
    return true;
  };
  ApiKpiFetcher.prototype.destroy = function () {
    if (this.messageHandler) window.removeEventListener("message", this.messageHandler);
    this.dataStores = {};
    this.kpiStore = null;
    this.lastResponse = null;
    if (this.domNode && this.domNode.parentNode) this.domNode.parentNode.removeChild(this.domNode);
    this.domNode = null;
    this.m_oControlHost = null;
  };

  return ApiKpiFetcher;
});
