define([], function () {
  "use strict";

  // ═══════════════════════════════════════════════════════════════════════════
  // chartRenderer.js — SF1000 dashboard (d3 v7)
  //
  // Ported from the approved Claude Design mockup, generalized to live data:
  //   • Panel 1  Trend — one line per MIS bucket, X = production month
  //   • Panel 2  Drill-down — cumulative area/line + incremental delta bars (MIS tabs)
  //   • Panel 3  Early-warning heatmap — MIS × production month, delta/value coloured
  //   • KPI cards + Absolute/Delta toggle + hover tooltips
  //
  // Dynamic: MIS buckets and colours come from the response (palette cycles).
  // Charts are time-based, so they render only for aggregation = production_month.
  // d3 is loaded from config.chart.d3Url with window.define temporarily nulled
  // (the d3 UMD bundle otherwise registers anonymously under RequireJS and breaks).
  //
  // render(container, {response, aggParam, aggArrayKey, kpiLabel, chartConfig})
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("[ChartRenderer] FILE LOADED");

  var DEFAULT_D3 = "https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js";

  // Dark theme tokens (from the mockup)
  var C = {
    bg: "#0f1117",
    panel: "#161922",
    panel2: "#11141c",
    border: "#242838",
    border2: "#2a2d3e",
    text: "#e6e8ef",
    muted: "#7e859c",
    muted2: "#8a90a6",
    head: "#cfd3e0",
    accent: "#f5a623",
    green: "#2ec27e",
    red: "#d0021b",
    grid: "#202433",
  };
  // MIS line palette (cycles if more buckets than colours)
  var PALETTE = [
    "#5b9bd5",
    "#19b6a6",
    "#f5a623",
    "#ef5b52",
    "#a06cd5",
    "#56c2e6",
    "#7ed957",
    "#e6a456",
    "#d05b8c",
    "#9aa0b6",
  ];

  function ChartRenderer() {
    this.d3 = null;
    this.root = null;
    this.tip = null;
    this.ro = null;
    this.metric = "absolute"; // 'absolute' (value) | 'delta'
    this.activeMIS = null;
    this._resizeT = null;
  }

  // ─────────────────────────── d3 loader ───────────────────────────
  ChartRenderer.prototype._ensureD3 = function (url, cb) {
    if (window.d3) return cb(window.d3);
    var existing = document.getElementById("fk-d3-script");
    if (existing) {
      var poll = setInterval(function () {
        if (window.d3) {
          clearInterval(poll);
          cb(window.d3);
        }
      }, 40);
      setTimeout(function () {
        clearInterval(poll);
        if (!window.d3) cb(null);
      }, 12000);
      return;
    }
    var prevDefine = window.define; // hide AMD so the UMD bundle attaches to window.d3
    try {
      window.define = undefined;
    } catch (e) {}
    var s = document.createElement("script");
    s.id = "fk-d3-script";
    s.src = url;
    s.onload = function () {
      window.define = prevDefine;
      cb(window.d3 || null);
    };
    s.onerror = function () {
      window.define = prevDefine;
      cb(null);
    };
    document.head.appendChild(s);
  };

  // ─────────────────────────── entry ───────────────────────────
  ChartRenderer.prototype.render = function (container, params) {
    var self = this;
    this.params = params || {};
    this.cfg = this.params.chartConfig || {};
    this.aggParam = this.params.aggParam;
    this.arrayKey = this.params.aggArrayKey;
    this.kpiLabel = this.params.kpiLabel || "SF1000";
    this.alert = typeof this.cfg.alertThreshold === "number" ? this.cfg.alertThreshold : 500;
    this.bands = this.cfg.deltaBands || { good: 50, warn: 100 };

    // Time-trend dashboard only makes sense for production_month.
    if (this.aggParam !== "production_month") {
      container.innerHTML =
        '<div class="fk-banner">The dashboard is a <strong>time-trend</strong> view (X axis = production month). ' +
        "Set <strong>Aggregation = Production Month</strong> to see the charts. " +
        "(Current: <code>" +
        this._esc(this.aggParam) +
        "</code>)</div>";
      return { tableText: "" };
    }

    container.innerHTML =
      '<div style="padding:40px;text-align:center;color:' +
      C.muted +
      ";background:" +
      C.bg +
      ';border-radius:11px;font-family:-apple-system,sans-serif">Loading chart engine\u2026</div>';

    this._ensureD3(this.cfg.d3Url || DEFAULT_D3, function (d3) {
      if (!d3) {
        container.innerHTML =
          '<div class="fk-error-block">Could not load the chart engine (d3) from <code>' +
          self._esc(self.cfg.d3Url || DEFAULT_D3) +
          "</code>.<br>Set <code>chart.d3Url</code> in config.json to a copy reachable from Cognos (e.g. your GitHub Pages).</div>";
        return;
      }
      self.d3 = d3;
      try {
        self._prepare();
        self._buildShell(container);
        self._wire();
        self._drawAll();
        self._observe();
      } catch (e) {
        console.error("[ChartRenderer] render error:", e);
        container.innerHTML =
          '<div class="fk-error-block">Chart render error: <code>' + self._esc(e.message) + "</code></div>";
      }
    });

    return { tableText: "" };
  };

  // ─────────────────────────── data prep ───────────────────────────
  ChartRenderer.prototype._prepare = function () {
    var d3 = this.d3,
      self = this;
    var resp = this.params.response || {};
    var dc = resp.damage_case_1000 || [];

    this.parse = d3.timeParse("%Y-%m");
    this.fmtAxis = d3.timeFormat("%b %y");
    this.fmtFull = d3.timeFormat("%b %Y");
    this.f2 = d3.format(",.2f");
    this.f0 = d3.format(",.0f");

    this.series = dc
      .map(function (b) {
        var pts = (b[self.arrayKey] || [])
          .map(function (p) {
            var m = p[self.aggParam];
            return {
              month: m,
              date: self.parse(m),
              value: +p.damage_cases_per_1000,
              delta: +p.delta_damage_cases_per_1000,
              vin: p.affected_vin_count,
              app: p.application_id_count,
            };
          })
          .filter(function (p) {
            return p.date;
          });
        pts.sort(function (a, b2) {
          return a.date - b2.date;
        });
        return { mis: +b.mis_bucket, points: pts };
      })
      .filter(function (s) {
        return s.points.length;
      });

    this.series.sort(function (a, b2) {
      return a.mis - b2.mis;
    });

    this.colorOf = {};
    this.series.forEach(function (s, i) {
      self.colorOf[s.mis] = PALETTE[i % PALETTE.length];
    });
    this.misOrder = this.series.map(function (s) {
      return s.mis;
    });
    if (this.activeMIS === null || this.misOrder.indexOf(this.activeMIS) === -1) {
      this.activeMIS = this.misOrder[0];
    }

    var monthsSet = {};
    this.series.forEach(function (s) {
      s.points.forEach(function (p) {
        monthsSet[p.month] = true;
      });
    });
    this.allMonths = Object.keys(monthsSet).sort();

    var allVals = [];
    this.series.forEach(function (s) {
      s.points.forEach(function (p) {
        allVals.push(p.value);
      });
    });
    this.maxVal = allVals.length ? Math.max.apply(null, allVals) : 0;
    this.minVal = allVals.length ? Math.min.apply(null, allVals) : 0;
  };

  ChartRenderer.prototype._metric = function (p) {
    return this.metric === "absolute" ? p.value : p.delta;
  };
  ChartRenderer.prototype._metricLabel = function () {
    return this.metric === "absolute" ? this.kpiLabel : "\u0394 " + this.kpiLabel;
  };
  ChartRenderer.prototype._deltaColor = function (v) {
    return v < this.bands.good ? C.green : v <= this.bands.warn ? C.accent : C.red;
  };

  // ─────────────────────────── shell DOM ───────────────────────────
  ChartRenderer.prototype._buildShell = function (container) {
    var H = typeof this.cfg.height === "number" ? this.cfg.height : 760;
    var self = this;
    var card = function (label, id, color, extra) {
      return (
        '<div style="flex:1;background:' +
        C.panel +
        ";border:1px solid " +
        C.border +
        ';border-radius:9px;padding:9px 13px;display:flex;flex-direction:column;gap:3px">' +
        '<div style="font-size:10px;color:' +
        C.muted +
        ';text-transform:uppercase;letter-spacing:.7px;font-weight:600">' +
        label +
        (extra
          ? ' <span style="text-transform:none;letter-spacing:0;color:' +
            C.muted2 +
            ";font-family:'IBM Plex Mono',monospace\">" +
            extra +
            "</span>"
          : "") +
        "</div>" +
        '<div id="' +
        id +
        "\" style=\"font-family:'IBM Plex Mono',monospace;font-size:21px;font-weight:600;color:" +
        (color || C.text) +
        '">\u2014</div></div>'
      );
    };
    var section = function (title, bodyId, opts) {
      opts = opts || {};
      return (
        '<section style="' +
        (opts.flex || "flex:1") +
        ";background:" +
        C.panel +
        ";border:1px solid " +
        C.border +
        ';border-radius:11px;padding:12px 14px;display:flex;flex-direction:column;min-height:0;min-width:0">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex:0 0 auto">' +
        '<div style="font-size:13px;font-weight:600;letter-spacing:.2px;color:' +
        C.head +
        '">' +
        title +
        "</div>" +
        (opts.tabsId ? '<div id="' + opts.tabsId + '" style="display:flex;gap:6px;flex-wrap:wrap"></div>' : "") +
        "</div>" +
        '<div id="' +
        bodyId +
        '" style="flex:1 1 auto;min-height:0;position:relative;margin-top:4px"></div>' +
        (opts.legendId
          ? '<div id="' +
            opts.legendId +
            '" style="flex:0 0 auto;display:flex;gap:16px;flex-wrap:wrap;padding-top:6px"></div>'
          : "") +
        "</section>"
      );
    };

    container.innerHTML =
      '<div id="fk-dash" style="height:' +
      H +
      "px;width:100%;background:" +
      C.bg +
      ";color:" +
      C.text +
      ";font-family:'IBM Plex Sans',system-ui,sans-serif;padding:14px;display:flex;flex-direction:column;gap:12px;overflow:hidden;border-radius:12px;box-sizing:border-box\">" +
      '<header style="display:flex;flex-direction:column;gap:11px;flex:0 0 auto">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap">' +
      '<div style="display:flex;align-items:center;gap:12px">' +
      '<div style="width:38px;height:38px;border-radius:10px;background:' +
      C.accent +
      ';display:flex;align-items:center;justify-content:center;flex:0 0 auto">' +
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="' +
      C.bg +
      '" stroke-width="2"></circle><line x1="12" y1="12" x2="17" y2="8.5" stroke="' +
      C.bg +
      '" stroke-width="2" stroke-linecap="round"></line><circle cx="12" cy="12" r="1.7" fill="' +
      C.bg +
      '"></circle></svg>' +
      "</div>" +
      '<div><div style="font-size:20px;font-weight:700;letter-spacing:.2px;line-height:1.1">' +
      this._esc(this.kpiLabel) +
      " Quality Monitor</div>" +
      '<div style="font-size:12px;color:' +
      C.muted +
      ';margin-top:2px">Damage Cases per 1,000 Vehicles — by MIS Bucket</div></div>' +
      "</div>" +
      '<div style="display:flex;align-items:center">' +
      '<button id="fk-mAbs" style="padding:8px 15px;font-size:12px;font-weight:600;border:1px solid ' +
      C.border2 +
      ";background:" +
      C.panel2 +
      ";color:" +
      C.muted2 +
      ';cursor:pointer;font-family:inherit;border-radius:8px 0 0 8px">Absolute</button>' +
      '<button id="fk-mDelta" style="padding:8px 15px;font-size:12px;font-weight:600;border:1px solid ' +
      C.border2 +
      ";background:" +
      C.panel2 +
      ";color:" +
      C.muted2 +
      ';cursor:pointer;font-family:inherit;border-radius:0 8px 8px 0;margin-left:-1px">Delta (New)</button>' +
      "</div>" +
      "</div>" +
      '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
      card("Total MIS Buckets", "fk-kBuckets", C.text, '<span id="fk-kList"></span>') +
      card("Latest Production Month", "fk-kLatest", C.text) +
      card("Max " + this._esc(this.kpiLabel), "fk-kMax", C.accent) +
      card("Min " + this._esc(this.kpiLabel), "fk-kMin", C.green) +
      "</div>" +
      "</header>" +
      '<div style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:12px;min-height:0">' +
      section(this._esc(this.kpiLabel) + " Trend by MIS Bucket", "fk-trend", {
        flex: "flex:1",
        legendId: "fk-trendLeg",
      }) +
      '<div style="display:flex;flex-direction:column;gap:12px;min-height:0;min-width:0">' +
      section("MIS Drill-Down: Cumulative vs. Incremental", "fk-drill", {
        flex: "flex:0 0 56%",
        tabsId: "fk-misTabs",
      }) +
      section("Early-Warning Cockpit — MIS \u00D7 Production Month", "fk-heat", {
        flex: "flex:1 1 auto",
        legendId: "fk-heatLeg",
      }) +
      "</div>" +
      "</div>" +
      '<div id="fk-tip" style="position:fixed;left:0;top:0;pointer-events:none;opacity:0;z-index:99999;background:#0b0d13;border:1px solid #343a54;border-radius:8px;padding:9px 11px;font-size:11.5px;line-height:1.55;box-shadow:0 10px 30px rgba(0,0,0,.55);transition:opacity .1s;max-width:260px"></div>' +
      "</div>";

    this.root = container.querySelector("#fk-dash");
    this.tip = container.querySelector("#fk-tip");

    // KPI cards
    this.root.querySelector("#fk-kBuckets").textContent = this.series.length;
    this.root.querySelector("#fk-kList").textContent = "[" + this.misOrder.join(", ") + "]";
    this.root.querySelector("#fk-kLatest").textContent = this.allMonths.length
      ? this.fmtFull(this.parse(this.allMonths[this.allMonths.length - 1]))
      : "\u2014";
    this.root.querySelector("#fk-kMax").textContent = this.f2(this.maxVal);
    this.root.querySelector("#fk-kMin").textContent = this.f2(this.minVal);

    // MIS tabs
    var tabs = this.root.querySelector("#fk-misTabs");
    tabs.innerHTML = this.misOrder
      .map(function (m) {
        return (
          '<button data-mis="' +
          m +
          '" style="padding:5px 11px;font-size:11.5px;font-weight:600;border:1px solid ' +
          C.border2 +
          ";background:" +
          C.panel2 +
          ";color:" +
          C.muted2 +
          ';border-radius:6px;cursor:pointer;font-family:inherit">MIS ' +
          m +
          "</button>"
        );
      })
      .join("");

    // Trend legend
    var leg = this.root.querySelector("#fk-trendLeg");
    leg.innerHTML =
      this.misOrder
        .map(function (m) {
          return (
            '<div style="display:flex;align-items:center;gap:7px;font-size:11.5px;color:' +
            C.muted2 +
            ';font-weight:500"><span style="width:13px;height:3px;border-radius:2px;background:' +
            self.colorOf[m] +
            ';display:inline-block"></span>MIS ' +
            m +
            "</div>"
          );
        })
        .join("") +
      '<div style="display:flex;align-items:center;gap:7px;font-size:11.5px;color:' +
      C.muted2 +
      ';font-weight:500"><span style="width:13px;border-top:2px dashed ' +
      C.red +
      ';display:inline-block"></span>Alert (' +
      this.alert +
      ")</div>";

    this._styleToggle();
    this._styleTabs();
  };

  // ─────────────────────────── interaction wiring ───────────────────────────
  ChartRenderer.prototype._wire = function () {
    var self = this,
      R = this.root;
    R.querySelector("#fk-mAbs").addEventListener("click", function () {
      self._setMetric("absolute");
    });
    R.querySelector("#fk-mDelta").addEventListener("click", function () {
      self._setMetric("delta");
    });
    R.querySelectorAll("#fk-misTabs button").forEach(function (b) {
      b.addEventListener("click", function () {
        self._setMIS(+b.dataset.mis);
      });
    });
  };
  ChartRenderer.prototype._setMetric = function (m) {
    if (this.metric === m) return;
    this.metric = m;
    this._styleToggle();
    this._drawTrend();
    this._drawHeat();
  };
  ChartRenderer.prototype._setMIS = function (m) {
    this.activeMIS = m;
    this._styleTabs();
    this._drawDrill();
  };
  ChartRenderer.prototype._styleToggle = function () {
    var on = { background: "#1f2a44", color: "#cfe0ff", borderColor: "#2f6fd6" };
    var off = { background: C.panel2, color: C.muted2, borderColor: C.border2 };
    var a = this.root.querySelector("#fk-mAbs"),
      b = this.root.querySelector("#fk-mDelta");
    Object.assign(a.style, this.metric === "absolute" ? on : off);
    Object.assign(b.style, this.metric === "delta" ? on : off);
  };
  ChartRenderer.prototype._styleTabs = function () {
    var self = this;
    this.root.querySelectorAll("#fk-misTabs button").forEach(function (b) {
      var m = +b.dataset.mis;
      if (m === self.activeMIS) {
        b.style.background = self.colorOf[m];
        b.style.color = C.bg;
        b.style.borderColor = self.colorOf[m];
      } else {
        b.style.background = C.panel2;
        b.style.color = C.muted2;
        b.style.borderColor = C.border2;
      }
    });
  };

  // ─────────────────────────── tooltip ───────────────────────────
  ChartRenderer.prototype._showTip = function (html, e) {
    this.tip.innerHTML = html;
    this.tip.style.opacity = 1;
    this._moveTip(e);
  };
  ChartRenderer.prototype._moveTip = function (e) {
    var pad = 15,
      t = this.tip,
      r = t.getBoundingClientRect();
    var x = e.clientX + pad,
      y = e.clientY + pad;
    if (x + r.width > window.innerWidth) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight) y = e.clientY - r.height - pad;
    t.style.left = x + "px";
    t.style.top = y + "px";
  };
  ChartRenderer.prototype._hideTip = function () {
    this.tip.style.opacity = 0;
  };
  ChartRenderer.prototype._tipHead = function (color, title) {
    return (
      '<div style="display:flex;align-items:center;gap:7px;margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid #262b40"><span style="width:9px;height:9px;border-radius:50%;background:' +
      color +
      '"></span><span style="font-weight:700;color:#fff">' +
      title +
      "</span></div>"
    );
  };
  ChartRenderer.prototype._tipRow = function (label, val, color) {
    return (
      '<div style="display:flex;justify-content:space-between;gap:18px"><span style="color:' +
      C.muted +
      '">' +
      label +
      "</span><span style=\"font-family:'IBM Plex Mono',monospace;color:" +
      (color || C.text) +
      ';font-weight:500">' +
      val +
      "</span></div>"
    );
  };

  // ─────────────────────────── layout / sizing ───────────────────────────
  ChartRenderer.prototype._dims = function (id) {
    var el = this.root.querySelector(id);
    var r = el.getBoundingClientRect();
    return { el: el, w: Math.max(60, Math.floor(r.width)), h: Math.max(60, Math.floor(r.height)) };
  };
  ChartRenderer.prototype._svg = function (el, w, h) {
    el.innerHTML = "";
    return this.d3.select(el).append("svg").attr("width", w).attr("height", h);
  };
  ChartRenderer.prototype._tickEvery = function (n) {
    return Math.max(1, Math.ceil(n / 8));
  };

  ChartRenderer.prototype._drawAll = function () {
    this._drawTrend();
    this._drawDrill();
    this._drawHeat();
  };
  ChartRenderer.prototype._observe = function () {
    var self = this;
    if (typeof ResizeObserver === "undefined") return;
    this.ro = new ResizeObserver(function () {
      clearTimeout(self._resizeT);
      self._resizeT = setTimeout(function () {
        if (self.root && self.root.isConnected) self._drawAll();
      }, 140);
    });
    this.ro.observe(this.root);
  };

  // ─────────────────────────── PANEL 1: TREND ───────────────────────────
  ChartRenderer.prototype._drawTrend = function () {
    var d3 = this.d3,
      self = this,
      dm = this._dims("#fk-trend");
    var m = { t: 10, r: 16, b: 24, l: 46 },
      iw = dm.w - m.l - m.r,
      ih = dm.h - m.t - m.b;
    if (iw < 20 || ih < 20) return;

    var x = d3.scalePoint().domain(this.allMonths).range([0, iw]).padding(0.5);
    var maxY =
      d3.max(this.series, function (s) {
        return d3.max(s.points, function (p) {
          return self._metric(p);
        });
      }) || 1;
    if (this.metric === "absolute") maxY = Math.max(maxY, this.alert);
    var y = d3
      .scaleLinear()
      .domain([0, maxY * 1.08])
      .nice()
      .range([ih, 0]);

    var svg = this._svg(dm.el, dm.w, dm.h),
      g = svg.append("g").attr("transform", "translate(" + m.l + "," + m.t + ")");

    // gridlines
    g.append("g")
      .selectAll("line")
      .data(y.ticks(5))
      .enter()
      .append("line")
      .attr("x1", 0)
      .attr("x2", iw)
      .attr("y1", function (d) {
        return y(d);
      })
      .attr("y2", function (d) {
        return y(d);
      })
      .attr("stroke", C.grid)
      .attr("stroke-width", 1);

    // axes
    var every = this._tickEvery(this.allMonths.length);
    var xAxis = d3
      .axisBottom(x)
      .tickValues(
        this.allMonths.filter(function (d, i) {
          return i % every === 0;
        }),
      )
      .tickFormat(function (d) {
        return self.fmtAxis(self.parse(d));
      });
    var gx = g
      .append("g")
      .attr("transform", "translate(0," + ih + ")")
      .call(xAxis);
    var gy = g.append("g").call(d3.axisLeft(y).ticks(5).tickFormat(d3.format("~s")));
    this._styleAxis(gx);
    this._styleAxis(gy);

    // alert line (absolute only)
    if (this.metric === "absolute" && this.alert <= maxY * 1.08) {
      g.append("line")
        .attr("x1", 0)
        .attr("x2", iw)
        .attr("y1", y(this.alert))
        .attr("y2", y(this.alert))
        .attr("stroke", C.red)
        .attr("stroke-width", 1.5)
        .attr("stroke-dasharray", "5,4")
        .attr("opacity", 0.8);
    }

    var line = d3
      .line()
      .defined(function (p) {
        return self._metric(p) != null && !isNaN(self._metric(p));
      })
      .x(function (p) {
        return x(p.month);
      })
      .y(function (p) {
        return y(self._metric(p));
      });

    this.series.forEach(function (s, si) {
      var col = self.colorOf[s.mis];
      var path = g
        .append("path")
        .datum(s.points)
        .attr("fill", "none")
        .attr("stroke", col)
        .attr("stroke-width", 2)
        .attr("stroke-linejoin", "round")
        .attr("d", line);
      var tot = path.node().getTotalLength();
      if (tot && isFinite(tot)) {
        path
          .attr("stroke-dasharray", tot + " " + tot)
          .attr("stroke-dashoffset", tot)
          .transition()
          .duration(800)
          .delay(si * 80)
          .ease(d3.easeCubicInOut)
          .attr("stroke-dashoffset", 0)
          .on("end", function () {
            d3.select(this).attr("stroke-dasharray", null);
          });
      }
      var dots = g
        .selectAll(".dot-" + s.mis)
        .data(s.points)
        .enter()
        .append("circle")
        .attr("cx", function (p) {
          return x(p.month);
        })
        .attr("cy", function (p) {
          return y(self._metric(p));
        })
        .attr("r", 0)
        .attr("fill", col)
        .attr("stroke", C.bg)
        .attr("stroke-width", 1)
        .style("cursor", "pointer")
        .on("mouseover", function (ev, p) {
          self._showTip(
            self._tipHead(col, "MIS " + s.mis + " \u00B7 " + self.fmtFull(p.date)) +
              self._tipRow(self.kpiLabel, self.f2(p.value)) +
              self._tipRow("\u0394 New", self.f2(p.delta), self._deltaColor(p.delta)) +
              (p.vin != null ? self._tipRow("Affected VIN", self.f0(p.vin)) : ""),
            ev,
          );
        })
        .on("mousemove", function (ev) {
          self._moveTip(ev);
        })
        .on("mouseout", function () {
          self._hideTip();
        });
      dots
        .transition()
        .delay(function (d, i) {
          return 500 + si * 80 + i * 15;
        })
        .duration(250)
        .attr("r", 3);
    });
  };

  // ─────────────────────────── PANEL 2: DRILL-DOWN ───────────────────────────
  ChartRenderer.prototype._drawDrill = function () {
    var d3 = this.d3,
      self = this,
      dm = this._dims("#fk-drill");
    var m = { t: 12, r: 46, b: 24, l: 46 },
      iw = dm.w - m.l - m.r,
      ih = dm.h - m.t - m.b;
    if (iw < 20 || ih < 20) return;

    var s = this.series.filter(function (q) {
      return q.mis === self.activeMIS;
    })[0];
    var svg = this._svg(dm.el, dm.w, dm.h),
      g = svg.append("g").attr("transform", "translate(" + m.l + "," + m.t + ")");
    if (!s || !s.points.length) {
      g.append("text")
        .attr("x", iw / 2)
        .attr("y", ih / 2)
        .attr("text-anchor", "middle")
        .attr("fill", C.muted)
        .text("No data for MIS " + this.activeMIS);
      return;
    }
    var col = this.colorOf[s.mis];
    var months = s.points.map(function (p) {
      return p.month;
    });
    var x = d3.scalePoint().domain(months).range([0, iw]).padding(0.5);
    var ly = d3
      .scaleLinear()
      .domain([
        0,
        (d3.max(s.points, function (p) {
          return p.value;
        }) || 1) * 1.08,
      ])
      .nice()
      .range([ih, 0]);
    var maxD =
      d3.max(s.points, function (p) {
        return Math.abs(p.delta);
      }) || 1;
    var ry = d3
      .scaleLinear()
      .domain([0, maxD * 1.15])
      .nice()
      .range([ih, 0]);

    g.append("g")
      .selectAll("line")
      .data(ly.ticks(5))
      .enter()
      .append("line")
      .attr("x1", 0)
      .attr("x2", iw)
      .attr("y1", function (d) {
        return ly(d);
      })
      .attr("y2", function (d) {
        return ly(d);
      })
      .attr("stroke", C.grid);

    // delta bars (right axis) — visual only; hover handled by overlay bands below
    var bw = Math.max(4, (iw / Math.max(1, months.length)) * 0.45);
    g.selectAll(".bar")
      .data(s.points)
      .enter()
      .append("rect")
      .attr("x", function (p) {
        return x(p.month) - bw / 2;
      })
      .attr("width", bw)
      .attr("rx", 2)
      .attr("fill", function (p) {
        return self._deltaColor(p.delta);
      })
      .attr("opacity", 0.85)
      .style("pointer-events", "none")
      .attr("y", ih)
      .attr("height", 0)
      .transition()
      .duration(650)
      .delay(function (d, i) {
        return i * 25;
      })
      .ease(d3.easeCubicOut)
      .attr("y", function (p) {
        return ry(Math.abs(p.delta));
      })
      .attr("height", function (p) {
        return ih - ry(Math.abs(p.delta));
      });

    // cumulative area + line (left axis) — visual only
    var area = g
      .append("path")
      .datum(s.points)
      .attr("fill", col)
      .style("pointer-events", "none")
      .attr(
        "d",
        d3
          .area()
          .x(function (p) {
            return x(p.month);
          })
          .y0(ih)
          .y1(function (p) {
            return ly(p.value);
          }),
      );
    area.attr("opacity", 0).transition().duration(800).attr("opacity", 0.12);

    var lpath = g
      .append("path")
      .datum(s.points)
      .attr("fill", "none")
      .attr("stroke", col)
      .attr("stroke-width", 2.2)
      .style("pointer-events", "none")
      .attr(
        "d",
        d3
          .line()
          .x(function (p) {
            return x(p.month);
          })
          .y(function (p) {
            return ly(p.value);
          }),
      );
    var ltot = lpath.node().getTotalLength();
    if (ltot && isFinite(ltot)) {
      lpath
        .attr("stroke-dasharray", ltot + " " + ltot)
        .attr("stroke-dashoffset", ltot)
        .transition()
        .duration(800)
        .ease(d3.easeCubicInOut)
        .attr("stroke-dashoffset", 0)
        .on("end", function () {
          d3.select(this).attr("stroke-dasharray", null);
        });
    }
    g.selectAll(".cdot")
      .data(s.points)
      .enter()
      .append("circle")
      .attr("cx", function (p) {
        return x(p.month);
      })
      .attr("cy", function (p) {
        return ly(p.value);
      })
      .attr("fill", col)
      .attr("stroke", C.bg)
      .attr("stroke-width", 1)
      .style("pointer-events", "none")
      .attr("r", 0)
      .transition()
      .delay(function (d, i) {
        return 500 + i * 20;
      })
      .duration(250)
      .attr("r", 3);

    // transparent full-height hover bands — combined cumulative + delta tooltip
    var step = months.length > 1 ? x(months[1]) - x(months[0]) : iw;
    g.selectAll(".hb")
      .data(s.points)
      .enter()
      .append("rect")
      .attr("x", function (p) {
        return x(p.month) - step / 2;
      })
      .attr("y", 0)
      .attr("width", step)
      .attr("height", ih)
      .attr("fill", "transparent")
      .style("cursor", "pointer")
      .on("mouseover", function (ev, p) {
        self._showTip(
          self._tipHead(col, "MIS " + s.mis + " \u00B7 " + self.fmtFull(p.date)) +
            self._tipRow(self.kpiLabel + " (cum.)", self.f2(p.value), col) +
            self._tipRow("\u0394 New cases", self.f2(p.delta), self._deltaColor(p.delta)) +
            (p.vin != null ? self._tipRow("Affected VIN", self.f0(p.vin)) : ""),
          ev,
        );
      })
      .on("mousemove", function (ev) {
        self._moveTip(ev);
      })
      .on("mouseout", function () {
        self._hideTip();
      });

    // alert line
    if (this.alert <= ly.domain()[1]) {
      g.append("line")
        .attr("x1", 0)
        .attr("x2", iw)
        .attr("y1", ly(this.alert))
        .attr("y2", ly(this.alert))
        .attr("stroke", C.red)
        .attr("stroke-width", 1.5)
        .attr("stroke-dasharray", "5,4")
        .attr("opacity", 0.8)
        .style("pointer-events", "none");
    }

    var every = this._tickEvery(months.length);
    var gx = g
      .append("g")
      .attr("transform", "translate(0," + ih + ")")
      .call(
        d3
          .axisBottom(x)
          .tickValues(
            months.filter(function (d, i) {
              return i % every === 0;
            }),
          )
          .tickFormat(function (d) {
            return self.fmtAxis(self.parse(d));
          }),
      );
    var gyl = g.append("g").call(d3.axisLeft(ly).ticks(5).tickFormat(d3.format("~s")));
    var gyr = g
      .append("g")
      .attr("transform", "translate(" + iw + ",0)")
      .call(d3.axisRight(ry).ticks(5).tickFormat(d3.format("~s")));
    this._styleAxis(gx);
    this._styleAxis(gyl);
    this._styleAxis(gyr);
    gyl
      .append("text")
      .attr("x", 0)
      .attr("y", -2)
      .attr("fill", col)
      .attr("font-size", 9)
      .attr("text-anchor", "start")
      .text("cum.");
    gyr
      .append("text")
      .attr("x", 0)
      .attr("y", -2)
      .attr("fill", C.muted)
      .attr("font-size", 9)
      .attr("text-anchor", "end")
      .text("\u0394");
  };

  // ─────────────────────────── PANEL 3: HEATMAP ───────────────────────────
  ChartRenderer.prototype._drawHeat = function () {
    var d3 = this.d3,
      self = this,
      dm = this._dims("#fk-heat");
    var m = { t: 6, r: 8, b: 22, l: 40 },
      iw = dm.w - m.l - m.r,
      ih = dm.h - m.t - m.b;
    if (iw < 20 || ih < 20) return;

    var x = d3.scaleBand().domain(this.allMonths).range([0, iw]).padding(0.06);
    var y = d3.scaleBand().domain(this.misOrder.map(String)).range([0, ih]).padding(0.12);

    var seqMax = this.metric === "absolute" ? this.maxVal || 1 : 1;
    var seq = d3.scaleSequential(d3.interpolateYlOrRd).domain([0, seqMax]);
    var fill = function (p) {
      return self.metric === "absolute" ? seq(p.value) : self._deltaColor(p.delta);
    };

    var svg = this._svg(dm.el, dm.w, dm.h),
      g = svg.append("g").attr("transform", "translate(" + m.l + "," + m.t + ")");

    var showText = x.bandwidth() >= 26 && y.bandwidth() >= 13;
    var fs = Math.min(11, Math.floor(y.bandwidth() * 0.5));
    this.series.forEach(function (s, si) {
      g.selectAll(".c-" + s.mis)
        .data(s.points)
        .enter()
        .append("rect")
        .attr("x", function (p) {
          return x(p.month);
        })
        .attr("y", y(String(s.mis)))
        .attr("width", x.bandwidth())
        .attr("height", y.bandwidth())
        .attr("rx", 2)
        .attr("fill", fill)
        .style("cursor", "pointer")
        .on("mouseover", function (ev, p) {
          self._showTip(
            self._tipHead(fill(p), "MIS " + s.mis + " \u00B7 " + self.fmtFull(p.date)) +
              self._tipRow(self.kpiLabel, self.f2(p.value)) +
              self._tipRow("\u0394 New", self.f2(p.delta), self._deltaColor(p.delta)),
            ev,
          );
        })
        .on("mousemove", function (ev) {
          self._moveTip(ev);
        })
        .on("mouseout", function () {
          self._hideTip();
        })
        .attr("opacity", 0)
        .transition()
        .duration(400)
        .delay(function (d, i) {
          return si * 40 + i * 8;
        })
        .attr("opacity", 1);

      if (showText) {
        g.selectAll(".tx-" + s.mis)
          .data(s.points)
          .enter()
          .append("text")
          .attr("x", function (p) {
            return x(p.month) + x.bandwidth() / 2;
          })
          .attr("y", y(String(s.mis)) + y.bandwidth() / 2)
          .attr("text-anchor", "middle")
          .attr("dominant-baseline", "central")
          .attr("font-size", fs + "px")
          .attr("font-family", "'IBM Plex Mono',monospace")
          .attr("fill", function (p) {
            return self._textColor(fill(p));
          })
          .style("pointer-events", "none")
          .text(function (p) {
            return self.metric === "absolute" ? self.f0(p.value) : (p.delta >= 0 ? "+" : "") + self.f0(p.delta);
          })
          .attr("opacity", 0)
          .transition()
          .delay(function (d, i) {
            return 200 + si * 40 + i * 8;
          })
          .duration(300)
          .attr("opacity", 1);
      }
    });

    var every = this._tickEvery(this.allMonths.length);
    var gx = g
      .append("g")
      .attr("transform", "translate(0," + ih + ")")
      .call(
        d3
          .axisBottom(x)
          .tickValues(
            this.allMonths.filter(function (d, i) {
              return i % every === 0;
            }),
          )
          .tickFormat(function (d) {
            return self.fmtAxis(self.parse(d));
          }),
      );
    var gy = g.append("g").call(
      d3.axisLeft(y).tickFormat(function (d) {
        return "MIS " + d;
      }),
    );
    this._styleAxis(gx);
    this._styleAxis(gy);

    // legend
    var leg = this.root.querySelector("#fk-heatLeg");
    if (this.metric === "delta") {
      leg.innerHTML =
        this._legSwatch(C.green, "< " + this.bands.good) +
        this._legSwatch(C.accent, this.bands.good + "\u2013" + this.bands.warn) +
        this._legSwatch(C.red, "> " + this.bands.warn) +
        '<span style="font-size:10.5px;color:' +
        C.muted +
        '">\u0394 new cases / 1000</span>';
    } else {
      leg.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:10.5px;color:' +
        C.muted +
        '">0</span>' +
        '<span style="width:120px;height:10px;border-radius:3px;display:inline-block;background:linear-gradient(90deg,' +
        seq(0) +
        "," +
        seq(seqMax * 0.5) +
        "," +
        seq(seqMax) +
        ')"></span>' +
        '<span style="font-size:10.5px;color:' +
        C.muted +
        '">' +
        this.f0(seqMax) +
        " " +
        this._esc(this.kpiLabel) +
        "</span></div>";
    }
  };
  ChartRenderer.prototype._legSwatch = function (color, label) {
    return (
      '<div style="display:flex;align-items:center;gap:6px;font-size:10.5px;color:' +
      C.muted2 +
      '"><span style="width:12px;height:12px;border-radius:3px;background:' +
      color +
      ';display:inline-block"></span>' +
      label +
      "</div>"
    );
  };

  // ─────────────────────────── axis styling ───────────────────────────
  ChartRenderer.prototype._styleAxis = function (sel) {
    sel.style("pointer-events", "none");
    sel
      .selectAll("text")
      .attr("fill", C.muted2)
      .attr("font-size", "10px")
      .attr("font-family", "'IBM Plex Mono',monospace");
    sel.selectAll("line").attr("stroke", C.border2);
    sel.selectAll("path").attr("stroke", C.border2);
  };

  // ─────────────────────────── misc ───────────────────────────
  ChartRenderer.prototype._textColor = function (bg) {
    var c = this.d3.color(bg);
    if (!c) return "#1a1a1a";
    c = c.rgb();
    var lum = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
    return lum > 0.62 ? "#1a1a1a" : "#ffffff";
  };
  ChartRenderer.prototype._esc = function (s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  };
  ChartRenderer.prototype.destroy = function () {
    if (this.ro) {
      try {
        this.ro.disconnect();
      } catch (e) {}
      this.ro = null;
    }
    if (this.tip && this.tip.parentNode) this.tip.parentNode.removeChild(this.tip);
    this.tip = null;
    this.root = null;
  };

  return ChartRenderer;
});
