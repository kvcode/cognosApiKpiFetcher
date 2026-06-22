define([], function () {
  "use strict";

  // ═══════════════════════════════════════════════════════════════════════════
  // listRenderer.js
  //
  // Renders the SF1000 response as a PIVOT table:
  //   rows    = the selected aggregation dimension values (from the response)
  //   columns = MIS buckets (from the response, == the distinct MIS values sent)
  //   cell    = damage_cases_per_1000 (+ delta_damage_cases_per_1000 beneath)
  //
  // It also returns a clean markdown table string (params.out.tableText) so the
  // orchestrator's "Copy Table" button can hand it to an AI for validation
  // against the raw JSON.
  //
  // Response shape (see SF1000_Info.txt):
  //   { damage_case_1000: [ { mis_bucket, <aggArrayKey>: [ { <aggParam>, damage_cases_per_1000, delta_damage_cases_per_1000 } ] } ] }
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("[ListRenderer] FILE LOADED");

  function ListRenderer() {}

  // ── Colour rule ────────────────────────────────────────────────────────────
  // deltaThresholds are FRACTIONS of the KPI value (that's the only scale on
  // which {good:0, warn:0.1, critical:0.5} are meaningful). We colour the KPI
  // cell by relativeDelta = delta / value:
  //     relativeDelta >= critical  -> red   (deteriorating fast)
  //     relativeDelta >= warn      -> amber
  //     else                       -> green (stable / improving)
  // Baseline guard: at the lowest MIS bucket the API returns delta == value,
  // which is not a real change, so we treat it as neutral (no colour).
  // ⚠ Tune the thresholds in config.json -> buttons[].deltaThresholds.
  ListRenderer.prototype._colourClass = function (value, delta, th) {
    if (value === null || value === undefined) return "fk-cell-empty";
    if (delta === null || delta === undefined) return "fk-cell-neutral";
    if (delta === value) return "fk-cell-neutral"; // baseline bucket
    var rel = value !== 0 ? delta / value : 0;
    var crit = th && typeof th.critical === "number" ? th.critical : 0.5;
    var warn = th && typeof th.warn === "number" ? th.warn : 0.1;
    if (rel >= crit) return "fk-cell-crit";
    if (rel >= warn) return "fk-cell-warn";
    return "fk-cell-good";
  };

  ListRenderer.prototype._fmt = function (n) {
    if (n === null || n === undefined) return "—";
    if (typeof n !== "number") return String(n);
    return n.toFixed(2);
  };
  ListRenderer.prototype._fmtDelta = function (n) {
    if (n === null || n === undefined) return "";
    if (typeof n !== "number") return String(n);
    return (n >= 0 ? "+" : "") + n.toFixed(2);
  };
  ListRenderer.prototype._esc = function (s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  };

  // ── Main render ──────────────────────────────────────────────────────────────
  // params = {
  //   response, aggParam, aggArrayKey, rowHeaderLabel, kpiLabel, deltaThresholds
  // }
  ListRenderer.prototype.render = function (container, params) {
    container.innerHTML = "";

    var resp = params.response || {};
    var aggParam = params.aggParam;
    var aggArrayKey = params.aggArrayKey;
    var th = params.deltaThresholds || {};
    var buckets = resp.damage_case_1000 || [];

    if (!Array.isArray(buckets) || buckets.length === 0) {
      container.innerHTML =
        '<div class="fk-warn"><strong>No data.</strong> The response contained no ' +
        "<code>damage_case_1000</code> entries for this scope.</div>";
      return { tableText: "" };
    }

    // Build: rowKey -> { mis -> {value, delta} }, plus distinct MIS + row order
    var rowMap = {};
    var rowOrder = [];
    var misSeen = {};
    var self = this;

    buckets.forEach(function (bucket) {
      var mis = bucket.mis_bucket;
      misSeen[mis] = true;
      var items = bucket[aggArrayKey] || [];
      items.forEach(function (it) {
        var key = it[aggParam];
        if (key === undefined || key === null) return;
        if (!(key in rowMap)) {
          rowMap[key] = {};
          rowOrder.push(key);
        }
        rowMap[key][mis] = {
          value: it.damage_cases_per_1000,
          delta: it.delta_damage_cases_per_1000,
        };
      });
    });

    var misList = Object.keys(misSeen)
      .map(Number)
      .sort(function (a, b) {
        return a - b;
      });
    rowOrder.sort(); // "YYYY-MM" sorts chronologically; other dims sort alpha

    if (rowOrder.length === 0) {
      container.innerHTML =
        '<div class="fk-warn"><strong>No rows.</strong> No <code>' +
        this._esc(aggArrayKey) +
        "</code> array was present in the response — check the selected aggregation.</div>";
      return { tableText: "" };
    }

    var rowHdr = params.rowHeaderLabel || aggParam;
    var kpiLabel = params.kpiLabel || "KPI";

    // ── DOM table ──────────────────────────────────────────────────────────
    var html = ['<div class="fk-table-wrap"><table class="fk-table"><thead><tr>'];
    html.push('<th class="fk-rowhdr">' + this._esc(rowHdr) + "</th>");
    misList.forEach(function (m) {
      html.push("<th>" + self._esc(kpiLabel) + " · MIS=" + m + "</th>");
    });
    html.push("</tr></thead><tbody>");

    rowOrder.forEach(function (rk) {
      html.push('<tr><td class="fk-rowhdr">' + self._esc(rk) + "</td>");
      misList.forEach(function (m) {
        var cell = rowMap[rk][m];
        if (!cell) {
          html.push('<td class="fk-cell-empty">—</td>');
          return;
        }
        var cls = self._colourClass(cell.value, cell.delta, th);
        var d = self._fmtDelta(cell.delta);
        html.push(
          '<td class="' +
            cls +
            '"><span class="fk-val">' +
            self._esc(self._fmt(cell.value)) +
            "</span>" +
            (d ? '<span class="fk-delta">Δ ' + self._esc(d) + "</span>" : "") +
            "</td>"
        );
      });
      html.push("</tr>");
    });
    html.push("</tbody></table></div>");
    container.innerHTML = html.join("");

    // ── Markdown table for Copy Table (AI-validation friendly) ───────────────
    var lines = [];
    var head = ["| " + rowHdr];
    misList.forEach(function (m) {
      head.push(kpiLabel + " MIS=" + m + " (Δ)");
    });
    lines.push(head.join(" | ") + " |");
    lines.push(
      "| " +
        misList
          .map(function () {
            return "---";
          })
          .concat(["---"])
          .join(" | ") +
        " |"
    );
    rowOrder.forEach(function (rk) {
      var cols = ["| " + rk];
      misList.forEach(function (m) {
        var cell = rowMap[rk][m];
        if (!cell) {
          cols.push("—");
        } else {
          cols.push(self._fmt(cell.value) + " (" + self._fmtDelta(cell.delta) + ")");
        }
      });
      lines.push(cols.join(" | ") + " |");
    });

    return { tableText: lines.join("\n") };
  };

  return ListRenderer;
});
