/* ESS Workbench — client-side ESS desktop-assessment assistant.
 * No build step, no dependencies. Loads data/*.json, lets you pick a Bureau
 * site (or raw coordinates), opens every relevant environmental/heritage source
 * aimed at the location, runs the checks that can be automated (Atlas of Living
 * Australia), records Found / Nothing found / Failed / Manual per source, and
 * assembles an ESS report that mirrors the proforma. State is saved per-site in
 * localStorage. See docs/ for architecture + how to add sources. */
(() => {
  "use strict";

  // ---------------------------------------------------------------- constants
  const STATUS = { FOUND: "found", NONE: "none", FAILED: "failed", MANUAL: "manual", UNSET: "unset" };
  const STATUS_LABEL = { found: "Found", none: "Nothing found", failed: "Search failed", manual: "Manual", unset: "Not checked" };
  const BBOX_DELTA = 0.03; // ~3 km half-box for extent deep-links
  const LS_PREFIX = "ess-workbench:v1:";

  // Rough state bounding boxes (mirrors build/build_data.py). Heuristic only —
  // user can override with the State selector. Most-specific first.
  const STATE_BBOXES = [
    ["ACT", -35.92, -35.12, 148.76, 149.40],
    ["TAS", -43.75, -39.10, 143.80, 148.55],
    ["VIC", -39.20, -33.98, 140.96, 150.05],
    ["NSW", -37.51, -28.16, 140.99, 153.64],
    ["QLD", -29.18, -9.90, 137.99, 153.55],
    ["SA", -38.10, -25.99, 128.99, 141.02],
    ["NT", -26.01, -10.90, 128.99, 138.02],
    ["WA", -35.20, -13.68, 112.90, 129.02],
  ];
  function stateFromCoords(lat, lon) {
    if (lat == null || lon == null || isNaN(lat) || isNaN(lon)) return "";
    for (const [code, s, n, w, e] of STATE_BBOXES)
      if (lat >= s && lat <= n && lon >= w && lon <= e) return code;
    return "";
  }

  // ---------------------------------------------------------------- app state
  const DATA = { stations: [], sources: [], sourcesMeta: null, dropdowns: null, meta: null };
  const state = {
    site: null,        // { name, station_num, wmo, state, delivery_group, facility_types, lat, lon, refs, primary_facility, manual }
    findings: {},      // sourceId -> { status, note, result }
    report: {},        // sectionId -> { choice, note }
    date: "",
    maintenance: "",
    filterAttention: false, // dashboard: show only Manual/Failed/Not-checked
    showAttention: false,   // show the attention banner (after import / agent run)
  };
  const ATTENTION = ["manual", "failed", "unset"]; // statuses a human still owns

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
    return n;
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------------------------------------------------------------- data load
  async function loadData() {
    const files = {
      stations: "data/stations.json",
      sources: "data/sources.json",
      dropdowns: "data/dropdowns.json",
      meta: "data/meta.json",
    };
    const out = {};
    for (const [key, path] of Object.entries(files)) {
      const res = await fetch(path, { cache: "no-cache" });
      if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
      out[key] = await res.json();
    }
    DATA.stations = out.stations;
    DATA.sourcesMeta = out.sources;
    DATA.sources = out.sources.sources;
    DATA.dropdowns = out.dropdowns;
    DATA.meta = out.meta;
    REPORT_SECTIONS = out.sources.report_sections || [];
  }

  function showBanner(kind, html) {
    const b = $("#load-banner");
    b.className = `banner ${kind}`;
    b.innerHTML = html;
    b.hidden = false;
  }

  // ---------------------------------------------------------------- site pick
  let acIndex = -1, acMatches = [];
  function searchStations(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const starts = [], contains = [];
    for (const s of DATA.stations) {
      const name = s.name.toLowerCase();
      const num = String(s.station_num);
      if (name.startsWith(q) || num.startsWith(q)) starts.push(s);
      else if (name.includes(q) || (s.facility_types || []).some((t) => t.toLowerCase().includes(q))) contains.push(s);
      if (starts.length >= 40) break;
    }
    return starts.concat(contains).slice(0, 40);
  }
  function renderAcList(matches) {
    const ul = $("#station-results");
    ul.innerHTML = "";
    acMatches = matches; acIndex = -1;
    if (!matches.length) { ul.hidden = true; return; }
    matches.forEach((s, i) => {
      ul.append(el("li", { "data-i": i, onmousedown: (e) => { e.preventDefault(); selectStation(s); } },
        el("span", { class: "ac-name" }, s.name),
        el("span", { class: "ac-meta" }, `${s.state || "?"} · ${(s.facility_types[0] || s.primary_facility || "site")}${s.station_num ? " · " + s.station_num : ""}`)));
    });
    ul.hidden = false;
  }

  function selectStation(s) {
    $("#station-search").value = s.name;
    $("#station-results").hidden = true;
    loadSite({
      name: s.name, station_num: s.station_num, wmo: s.wmo, state: s.state,
      region: s.region, delivery_group: s.delivery_group, facility_types: s.facility_types,
      primary_facility: s.primary_facility, lat: s.lat, lon: s.lon,
      operating_authority: s.operating_authority, ident: s.ident, refs: s.refs, manual: false,
    });
  }

  function loadCoordSite() {
    const lat = parseFloat($("#in-lat").value), lon = parseFloat($("#in-lon").value);
    if (isNaN(lat) || isNaN(lon)) { alert("Enter a valid latitude and longitude."); return; }
    const st = $("#in-state").value || stateFromCoords(lat, lon);
    loadSite({
      name: $("#in-name").value.trim() || `Site @ ${lat.toFixed(4)}, ${lon.toFixed(4)}`,
      station_num: "", wmo: "", state: st, region: st, delivery_group: "", facility_types: [],
      primary_facility: "", lat, lon, operating_authority: "", ident: "",
      refs: refsForState(st), manual: true,
    });
  }

  // National reference links by state (fallback for manual coordinate sites).
  function refsForState(st) {
    const weeds = {
      QLD: "https://www.business.qld.gov.au/industries/farms-fishing-forestry/agriculture/biosecurity/plants/invasive/restricted",
      NSW: "https://weeds.org.au/regions/nsw/",
      VIC: "https://agriculture.vic.gov.au/biosecurity/weeds/weeds-information",
      SA: "https://www.landscape.sa.gov.au/hf/landscapes-hills-and-fleurieu-stewardship-program/understand-your-responsibilities-as-a-land-manager/pest-plants-and-animals-2/pest-plants",
      WA: "https://www.agric.wa.gov.au/pests-weeds-diseases/weeds",
      TAS: "https://nre.tas.gov.au/invasive-species/weeds-index",
      NT: "https://nt.gov.au/environment/weeds",
      ACT: "https://www.environment.act.gov.au/parks-conservation/plants-and-animals/pest-plants-and-animals",
    };
    return { invasive_plants: weeds[st] || "", invasive_animals: "https://www.dcceew.gov.au/environment/invasive-species", diseases: "https://www.outbreak.gov.au/" };
  }

  function siteKey(site) { return site.station_num ? `num:${site.station_num}` : `xy:${site.lat.toFixed(5)},${site.lon.toFixed(5)}`; }

  function loadSite(site) {
    // persist current before switching
    state.site = site;
    state.findings = {};
    state.report = {};
    state.date = new Date().toISOString().slice(0, 10);
    state.maintenance = "";
    state.filterAttention = false;
    state.showAttention = false;
    restore(); // pull any saved progress for this site
    renderWorkspace();
  }

  function renderWorkspace() {
    $("#workspace").hidden = false;
    renderSummary();
    renderDashboard();
    renderReport();
    renderProgress();
    syncFilterButton();
    $("#fld-date").value = state.date;
    $("#fld-maintenance").value = state.maintenance;
    $("#workspace").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Load a completed (or partial) ess-findings/1 object — from the agent skill
  // or a prior export — and populate the same review/export surface.
  function importFindings(json) {
    if (!json || typeof json !== "object" || !json.site || !Array.isArray(json.collection_log))
      throw new Error("Not an ESS findings file — expected a `site` object and a `collection_log` array.");
    const si = json.site;
    const lat = parseFloat(si.lat), lon = parseFloat(si.lon);
    if (isNaN(lat) || isNaN(lon)) throw new Error("The findings file has no valid site latitude/longitude.");
    const st = si.state || stateFromCoords(lat, lon);
    state.site = {
      name: si.name || `Site @ ${lat.toFixed(4)}, ${lon.toFixed(4)}`,
      station_num: si.station_num || "", wmo: si.wmo || "", region: st, state: st,
      delivery_group: si.delivery_group || "", facility_types: si.facility_types || [],
      primary_facility: (si.facility_types && si.facility_types[0]) || "",
      lat, lon, operating_authority: "", ident: "", refs: refsForState(st), manual: !si.station_num,
    };
    state.findings = {};
    json.collection_log.forEach((c) => {
      if (!c || !c.id) return;
      state.findings[c.id] = {
        status: c.status || STATUS.UNSET, note: c.note || "",
        result: c.result_text ? { html: esc(c.result_text).replace(/\n/g, "<br>"), ts: Date.now() } : null,
      };
    });
    state.report = {};
    (json.sections || []).forEach((s) => { if (s && s.id) state.report[s.id] = { choice: s.choice || null, note: s.note || "" }; });
    state.date = si.assessment_date || new Date().toISOString().slice(0, 10);
    state.maintenance = si.site_maintenance || "";
    state.filterAttention = false;
    state.showAttention = true; // surface what the agent left for the human
    renderWorkspace();
    save();
  }

  // ---------------------------------------------------------------- summary
  function renderSummary() {
    const s = state.site;
    const rows = [
      ["Station Name", s.name],
      ["Station Number", s.station_num || "—"],
      ["WMO Number", s.wmo || "—"],
      ["State", s.state || "—"],
      ["Delivery Group", s.delivery_group || "—"],
      ["Facility", (s.facility_types && s.facility_types.join(", ")) || s.primary_facility || "—"],
      ["Latitude", s.lat],
      ["Longitude", s.lon],
    ];
    const grid = $("#summary-grid");
    grid.innerHTML = "";
    rows.forEach(([k, v]) => {
      const isCoord = k === "Latitude" || k === "Longitude";
      grid.append(el("div", { class: "summary-item" },
        el("span", { class: "k" }, k),
        el("span", {
          class: "v" + (isCoord ? " copyable" : ""), title: isCoord ? "Click to copy" : null,
          onclick: isCoord ? () => copy(String(v)) : null,
        }, String(v))));
    });
    if (s.manual) grid.append(el("div", { class: "summary-item", style: "grid-column:1/-1" },
      el("span", { class: "k" }, "Source"), el("span", { class: "v" }, "Manual coordinate entry")));
  }

  // ---------------------------------------------------------------- deep links
  function buildUrl(src) {
    const s = state.site;
    const tmpl = src.url_template || src.url;
    if (!src.url_template) return src.url;
    const repl = {
      "{lat}": s.lat, "{lon}": s.lon, "{name}": encodeURIComponent(s.name), "{state}": s.state || "",
      "{lat_min}": (s.lat - BBOX_DELTA).toFixed(5), "{lat_max}": (s.lat + BBOX_DELTA).toFixed(5),
      "{lon_min}": (s.lon - BBOX_DELTA).toFixed(5), "{lon_max}": (s.lon + BBOX_DELTA).toFixed(5),
    };
    return tmpl.replace(/\{[a-z_]+\}/g, (m) => (m in repl ? repl[m] : m));
  }

  function sourcesForSite() {
    const st = state.site.state;
    const showInternal = $("#toggle-manual-internal").checked;
    return DATA.sources.filter((src) => {
      if (src.states && src.states[0] !== "*" && !src.states.includes(st)) return false;
      if (src.internal && !showInternal) return false;
      return true;
    });
  }

  // ---------------------------------------------------------------- dashboard
  function renderDashboard() {
    const wrap = $("#dashboard-groups");
    wrap.innerHTML = "";
    const cats = DATA.sourcesMeta.categories;
    let list = sourcesForSite();
    if (state.filterAttention)
      list = list.filter((s) => ATTENTION.includes((state.findings[s.id] || {}).status || "unset"));
    for (const cat of cats) {
      const inCat = list.filter((s) => s.category === cat.id).sort((a, b) => (a.priority || 99) - (b.priority || 99));
      if (!inCat.length) continue;
      const group = el("div", { class: "group" });
      group.append(el("div", { class: "group-head" },
        el("h3", {}, cat.label),
        el("span", { class: "g-count" }, `${inCat.length}`),
        el("span", { class: "g-line" })));
      inCat.forEach((src) => group.append(renderSourceCard(src)));
      wrap.append(group);
    }
    if (!wrap.children.length)
      wrap.append(el("p", { class: "dash-note", style: "margin:8px 0" },
        state.filterAttention ? "✓ Nothing needs attention — every source has a result." : "No sources for this site."));
  }

  function renderSourceCard(src) {
    const f = state.findings[src.id] || (state.findings[src.id] = { status: STATUS.UNSET, note: "", result: null });
    const card = el("div", { class: `src status-${f.status}`, id: `src-${src.id}` });

    const tags = [];
    if (src.method === "api") tags.push(el("span", { class: "tag api" }, "API"));
    if (src.internal) tags.push(el("span", { class: "tag internal" }, "Internal"));
    tags.push(el("span", { class: "tag jur" }, src.jurisdiction === "national" ? "National" : (state.site.state || "State")));

    const link = el("a", { href: buildUrl(src), target: "_blank", rel: "noopener", class: "btn tiny" }, "Open ↗");

    const statusSel = el("div", { class: "status-select" });
    [[STATUS.FOUND, "Found"], [STATUS.NONE, "None"], [STATUS.FAILED, "Failed"], [STATUS.MANUAL, "Manual"]].forEach(([s, lab]) => {
      statusSel.append(el("button", {
        "data-s": s, class: f.status === s ? "on" : "",
        onclick: () => setStatus(src.id, s),
      }, lab));
    });

    const actions = el("div", { class: "src-actions" }, link, statusSel);
    if (src.method === "api" && src.api && src.api.kind === "ala_biocache") {
      actions.append(el("button", { class: "btn tiny primary", id: `run-${src.id}`, onclick: () => runAla(src) }, "Check live"));
    }
    if (src.web_search) {
      const q = encodeURIComponent(fillTemplate(src.web_search));
      actions.append(el("a", { href: `https://www.google.com/search?q=${q}`, target: "_blank", rel: "noopener", class: "btn tiny" }, "Web search ↗"));
    }

    const note = el("textarea", { placeholder: "Notes / evidence for the report…", oninput: (e) => { f.note = e.target.value; save(); } });
    note.value = f.note || "";

    card.append(
      el("div", { class: "src-top" },
        el("div", { class: "src-name" }, src.name, ...tags),
        el("span", { class: "chip " + (f.status === "unset" ? "manual" : f.status), style: f.status === "unset" ? "opacity:.5" : "" }, STATUS_LABEL[f.status])),
      el("div", { class: "src-desc" }, src.what_to_find || ""),
      actions,
      el("div", { class: "src-note" }, note),
      el("div", { class: "src-result" + (f.result ? " show" : ""), id: `res-${src.id}`, html: f.result ? f.result.html : "" }),
    );
    return card;
  }

  function fillTemplate(str) {
    const s = state.site;
    return str.replace(/\{name\}/g, s.name).replace(/\{state\}/g, s.state || "")
      .replace(/\{lat\}/g, s.lat).replace(/\{lon\}/g, s.lon);
  }

  function setStatus(id, status) {
    const f = state.findings[id] || (state.findings[id] = { status: STATUS.UNSET, note: "", result: null });
    f.status = f.status === status ? STATUS.UNSET : status;
    save();
    refreshCard(id);
    renderProgress();
    renderReport(); // evidence + suggested choices may change
  }

  function refreshCard(id) {
    const src = DATA.sources.find((s) => s.id === id);
    const old = $(`#src-${id}`);
    if (old && src) old.replaceWith(renderSourceCard(src));
  }

  // ---------------------------------------------------------------- ALA check
  // Pure query: hit the Atlas of Living Australia and return a status + an HTML
  // card summary + a plain-text summary (for the agent). Shared by the card
  // "Check live" button and the BYOK agent's query_ala tool.
  async function alaQuery(lat, lon, radius, endpoint) {
    const base = endpoint || "https://biocache-ws.ala.org.au/ws/occurrences/search";
    const geo = `lat=${lat}&lon=${lon}&radius=${radius}`;
    const a = await fetchJson(`${base}?q=*%3A*&${geo}&pageSize=0&facets=stateConservation,countryConservation&flimit=30`);
    const total = a.totalRecords ?? 0;
    const consFacets = (a.facetResults || []).filter((fr) => /Conservation/i.test(fr.fieldName) && fr.fieldResult && fr.fieldResult.length);
    const statusCounts = [];
    consFacets.forEach((fr) => fr.fieldResult.forEach((r) => {
      const label = (r.label || "").trim();
      if (label && !/^unknown$/i.test(label)) statusCounts.push([label, r.count]);
    }));
    let speciesHtml = "", speciesText = "", listedCount = 0;
    if (statusCounts.length) {
      try {
        const b = await fetchJson(`${base}?q=*%3A*&fq=${encodeURIComponent("(stateConservation:* OR countryConservation:*)")}&${geo}&pageSize=0&facets=species&flimit=40`);
        const sp = ((b.facetResults || []).find((fr) => fr.fieldName === "species") || {}).fieldResult || [];
        listedCount = sp.length;
        if (sp.length) {
          speciesHtml = `<ul class="r-species">${sp.slice(0, 25).map((r) => `<li>${esc(r.label)} <span style="opacity:.6">(${r.count})</span></li>`).join("")}</ul>`;
          speciesText = " Listed taxa: " + sp.slice(0, 25).map((r) => `${r.label} (${r.count})`).join("; ") + ".";
        }
      } catch (_) { /* species drill-down is best-effort */ }
    }
    const dedup = {};
    statusCounts.forEach(([l, c]) => { dedup[l] = (dedup[l] || 0) + c; });
    const statusStr = Object.entries(dedup).map(([l, c]) => `${esc(l)} (${c})`).join(", ");
    const statusStrPlain = Object.entries(dedup).map(([l, c]) => `${l} (${c})`).join(", ");
    if (statusCounts.length) {
      return { status: STATUS.FOUND,
        html: `<b>${listedCount || "Multiple"} conservation-listed taxa</b> within ${radius} km.<br>Status classes: ${statusStr}.${speciesHtml}<div style="margin-top:6px;opacity:.7">${total.toLocaleString()} total occurrence records in radius. Source: Atlas of Living Australia.</div>`,
        text: `${listedCount || "Multiple"} conservation-listed taxa within ${radius} km. Status classes: ${statusStrPlain}.${speciesText} ${total} total occurrence records.` };
    }
    if (total > 0) {
      return { status: STATUS.NONE,
        html: `${total.toLocaleString()} occurrence records within ${radius} km, but <b>none carry a state/national conservation status</b>. Corroborate with EPBC PMST &amp; state tools.`,
        text: `${total} occurrence records within ${radius} km, but none carry a state/national conservation status.` };
    }
    return { status: STATUS.NONE,
      html: `<b>No occurrence records</b> within ${radius} km (sparsely surveyed area — this does not rule out species presence).`,
      text: `No occurrence records within ${radius} km (sparsely surveyed area; does not rule out species presence).` };
  }

  async function runAla(src) {
    const btn = $(`#run-${src.id}`);
    const res = $(`#res-${src.id}`);
    const s = state.site;
    const radius = (src.api && src.api.radius_km) || 10;
    btn.disabled = true; btn.innerHTML = `<span class="spin"></span> Checking…`;
    res.className = "src-result show"; res.innerHTML = "Querying Atlas of Living Australia…";
    try {
      const r = await alaQuery(s.lat, s.lon, radius, src.api && src.api.endpoint);
      const f = state.findings[src.id] || (state.findings[src.id] = {});
      f.status = r.status; f.result = { html: r.html, ts: Date.now() };
      save(); refreshCard(src.id); renderProgress(); renderReport();
    } catch (err) {
      const f = state.findings[src.id] || (state.findings[src.id] = {});
      f.status = STATUS.FAILED;
      f.result = { html: `Could not reach the Atlas of Living Australia API (${esc(err.message)}). This is usually a network or browser CORS restriction. Use the <b>Open ↗</b> link to check manually, then set the result.`, err: true, ts: Date.now() };
      save(); refreshCard(src.id);
      const r = $(`#res-${src.id}`); if (r) r.classList.add("err");
      renderProgress(); renderReport();
    }
  }

  async function fetchJson(url) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function runAllAuto() {
    for (const src of sourcesForSite())
      if (src.method === "api" && src.api && src.api.kind === "ala_biocache") await runAla(src);
  }

  // ---------------------------------------------------------------- progress
  function renderProgress() {
    const list = sourcesForSite();
    const counts = { found: 0, none: 0, failed: 0, manual: 0, unset: 0 };
    list.forEach((s) => { counts[(state.findings[s.id] || {}).status || "unset"]++; });
    const done = list.length - counts.unset;
    $("#progress-bar").style.width = list.length ? `${Math.round((done / list.length) * 100)}%` : "0";
    $("#progress-legend").innerHTML =
      `<span><b>${done}</b>/${list.length} checked</span>` +
      `<span class="chip found">${counts.found} found</span>` +
      `<span class="chip none">${counts.none} none</span>` +
      `<span class="chip failed">${counts.failed} failed</span>` +
      `<span class="chip manual">${counts.manual} manual</span>`;
    renderAttention();
  }

  // Banner drawing the eye to sources a human still owns (shown after an import
  // or agent run). Updates live as items are resolved; hides when dismissed.
  function renderAttention() {
    const b = $("#attention-banner");
    if (!b) return;
    if (!state.showAttention || !state.site) { b.hidden = true; return; }
    const list = sourcesForSite();
    const need = list.filter((s) => ATTENTION.includes((state.findings[s.id] || {}).status || "unset")).length;
    const done = list.length - need;
    b.hidden = false;
    b.className = "attention" + (need === 0 ? " clear" : "");
    b.innerHTML = "";
    const msg = need === 0
      ? el("span", {}, `All ${list.length} sources resolved — review the report and export.`)
      : el("span", { html: `<b>${done}</b> automated · <b>${need}</b> still need you (Manual / Failed / Not&nbsp;checked). Open each aimed link, then set its result.` });
    const actions = el("span", { style: "display:flex;gap:8px;flex-wrap:wrap" });
    if (need > 0) actions.append(el("button", {
      class: "btn tiny" + (state.filterAttention ? " on" : ""),
      onclick: () => { state.filterAttention = !state.filterAttention; renderDashboard(); renderAttention(); syncFilterButton(); },
    }, state.filterAttention ? "Show all" : "Show only these"));
    actions.append(el("button", { class: "btn tiny", onclick: () => { state.showAttention = false; renderAttention(); } }, "Dismiss"));
    b.append(msg, actions);
  }

  function syncFilterButton() {
    const btn = $("#btn-filter-attention");
    if (btn) btn.classList.toggle("on", state.filterAttention);
  }

  // ---------------------------------------------------------------- report
  // Report sections mirror the ESS proforma. The definition is the single
  // source of truth in data/sources.json (`report_sections`) so the browser
  // tool and the ess-collect skill stay in lockstep; populated on load.
  let REPORT_SECTIONS = [];

  // Suggest a dropdown option based on the findings in the relevant categories.
  function suggestChoice(section) {
    const opts = section.dropdown ? DATA.dropdowns[section.dropdown] : null;
    if (!opts) return null;
    const rel = sourcesForSite().filter((s) => section.cats.includes(s.category));
    const st = rel.map((s) => (state.findings[s.id] || {}).status);
    const anyFound = st.includes("found");
    // options are ordered: [none, known/at-site, local-area]; pick "known" when found.
    if (anyFound) return opts.length > 1 ? opts[1] : opts[0];
    return opts[0];
  }

  function evidenceFor(section) {
    const rel = sourcesForSite().filter((s) => section.cats.includes(s.category));
    return rel.map((s) => ({ src: s, f: state.findings[s.id] || { status: "unset" } }))
      .filter((x) => x.f.status && x.f.status !== "unset");
  }

  function renderReport() {
    const wrap = $("#report-sections");
    wrap.innerHTML = "";
    REPORT_SECTIONS.forEach((section) => {
      const rstate = state.report[section.id] || (state.report[section.id] = { choice: null, note: "" });
      if (rstate.choice == null && section.dropdown) rstate.choice = suggestChoice(section);

      const box = el("div", { class: "rsection" });
      box.append(el("h3", {}, section.title));

      if (section.dropdown) {
        const opts = DATA.dropdowns[section.dropdown] || [];
        const sel = el("select", { onchange: (e) => { rstate.choice = e.target.value; save(); if (section.bioDetail) syncBioDetail(section, box); } });
        opts.forEach((o) => sel.append(el("option", { value: o, selected: rstate.choice === o ? "selected" : null }, o)));
        box.append(el("div", { class: "r-field" }, sel));
      }

      if (section.bioDetail) {
        const detail = el("p", { class: "r-sub", id: "bio-detail" });
        box.append(detail);
        setTimeout(() => syncBioDetail(section, box), 0);
      }

      // Reference link for invasive/disease sections (mirrors the proforma hyperlinks)
      const ref = section.ref && state.site.refs && state.site.refs[section.ref];
      if (ref) box.append(el("p", { class: "r-sub" }, "Reference: ", el("a", { href: ref, target: "_blank", rel: "noopener" }, ref)));

      const ta = el("textarea", { placeholder: "Free-text comments for this section…", oninput: (e) => { rstate.note = e.target.value; save(); } });
      ta.value = rstate.note || "";
      box.append(el("div", { class: "r-field" }, ta));

      // Evidence chips from collection
      const ev = evidenceFor(section);
      if (ev.length) {
        const evWrap = el("div", { class: "evidence" }, "From collection: ");
        ev.forEach(({ src, f }) => evWrap.append(el("span", { class: "chip " + f.status }, `${src.name}: ${STATUS_LABEL[f.status]}`), " "));
        box.append(evWrap);
      }
      wrap.append(box);
    });
  }

  function syncBioDetail(section, box) {
    const rstate = state.report[section.id];
    const detail = box.querySelector("#bio-detail") || $("#bio-detail");
    const map = DATA.dropdowns.biosecurity_detail || {};
    if (detail) detail.textContent = map[rstate.choice] || "";
  }

  // ---------------------------------------------------------------- persistence
  function save() {
    if (!state.site) return;
    try {
      localStorage.setItem(LS_PREFIX + siteKey(state.site), JSON.stringify({
        site: state.site, findings: state.findings, report: state.report,
        date: $("#fld-date") ? $("#fld-date").value : state.date,
        maintenance: $("#fld-maintenance") ? $("#fld-maintenance").value : state.maintenance,
      }));
    } catch (_) { /* storage may be full/disabled — non-fatal */ }
  }
  function restore() {
    try {
      const raw = localStorage.getItem(LS_PREFIX + siteKey(state.site));
      if (!raw) return;
      const d = JSON.parse(raw);
      state.findings = d.findings || {};
      state.report = d.report || {};
      state.date = d.date || state.date;
      state.maintenance = d.maintenance || "";
    } catch (_) { /* ignore corrupt entry */ }
  }

  // ---------------------------------------------------------------- export
  function buildFindings() {
    const list = sourcesForSite();
    return list.map((s) => {
      const f = state.findings[s.id] || { status: "unset", note: "" };
      return {
        id: s.id, name: s.name, category: s.category, jurisdiction: s.jurisdiction,
        url: buildUrl(s), status: f.status || "unset", note: f.note || "",
        result_text: f.result ? f.result.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "",
      };
    });
  }

  function reportObject() {
    const s = state.site;
    return {
      schema: "ess-findings/1",
      generated: new Date().toISOString(),
      tool: "ESS Workbench",
      data_version: DATA.meta && DATA.meta.generated_utc,
      site: {
        name: s.name, station_num: s.station_num, wmo: s.wmo, state: s.state,
        delivery_group: s.delivery_group, facility_types: s.facility_types,
        lat: s.lat, lon: s.lon, assessment_date: $("#fld-date").value, site_maintenance: $("#fld-maintenance").value,
      },
      sections: REPORT_SECTIONS.map((sec) => ({
        id: sec.id, title: sec.title,
        choice: (state.report[sec.id] || {}).choice || "",
        note: (state.report[sec.id] || {}).note || "",
        detail: sec.bioDetail ? (DATA.dropdowns.biosecurity_detail || {})[(state.report[sec.id] || {}).choice] || "" : "",
      })),
      collection_log: buildFindings(),
    };
  }

  function buildReportHtml(forPrint) {
    const r = reportObject();
    const s = r.site;
    const secRows = r.sections.map((sec) => `<div class="pr-sec"><h2>${esc(sec.title)}</h2>
      ${sec.choice ? `<p><b>${esc(sec.choice)}</b></p>` : ""}
      ${sec.detail ? `<p>${esc(sec.detail)}</p>` : ""}
      ${sec.note ? `<p>${esc(sec.note)}</p>` : ""}</div>`).join("");
    const logRows = r.collection_log.map((c) => `<tr>
      <td>${esc(c.name)}</td>
      <td class="st st-${c.status}">${esc(STATUS_LABEL[c.status] || c.status)}</td>
      <td>${esc(c.result_text || c.note || "")}</td>
      <td><a href="${esc(c.url)}">link</a></td></tr>`).join("");
    return `<div class="pr">
      <h1>Environmental Site Summary — ${esc(s.name)}</h1>
      <p>Assessment date: ${esc(s.assessment_date || "")} · Generated ${esc(r.generated.slice(0, 10))}${r.data_version ? " · station data " + esc(r.data_version.slice(0, 10)) : ""}</p>
      <div class="pr-sec"><h2>Site</h2>
        <table>
          <tr><td class="k">Station Number</td><td>${esc(s.station_num || "—")}</td><td class="k">WMO</td><td>${esc(s.wmo || "—")}</td></tr>
          <tr><td class="k">State</td><td>${esc(s.state || "—")}</td><td class="k">Delivery Group</td><td>${esc(s.delivery_group || "—")}</td></tr>
          <tr><td class="k">Facility</td><td>${esc((s.facility_types || []).join(", ") || "—")}</td><td class="k">Site maintenance</td><td>${esc(s.site_maintenance || "—")}</td></tr>
          <tr><td class="k">Latitude</td><td>${esc(s.lat)}</td><td class="k">Longitude</td><td>${esc(s.lon)}</td></tr>
        </table></div>
      ${secRows}
      <div class="pr-sec"><h2>Collection log — sources checked</h2>
        <table><thead><tr><th>Source</th><th>Result</th><th>Evidence / notes</th><th></th></tr></thead>
        <tbody>${logRows}</tbody></table></div>
      <p style="margin-top:10px;color:#555">Prepared with ESS Workbench · contact enviro@bom.gov.au</p>
    </div>`;
  }

  function doPrint() {
    $("#print-root").innerHTML = buildReportHtml(true);
    window.print();
  }
  function download(name, mime, text) {
    const blob = new Blob([text], { type: mime });
    const a = el("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function downloadHtml() {
    const css = document.getElementById("print-styles-inline");
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ESS — ${esc(state.site.name)}</title>
      <style>body{font:13px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:820px;margin:24px auto;padding:0 16px;color:#111}
      h1{font-size:22px} .pr-sec{border:1px solid #ccc;border-radius:6px;padding:8px 12px;margin:10px 0}
      .pr-sec h2{font-size:14px;background:#12507b;color:#fff;margin:-8px -12px 8px;padding:6px 12px;border-radius:6px 6px 0 0}
      table{width:100%;border-collapse:collapse;font-size:12px} th,td{border:1px solid #ccc;padding:5px 7px;text-align:left;vertical-align:top}
      .k{color:#555} .st{font-weight:700} .st-found{color:#1f7a4d}.st-none{color:#8a6d1a}.st-failed{color:#b3261e}.st-manual{color:#3a5a99}</style>
      </head><body>${buildReportHtml(false)}</body></html>`;
    download(`ESS_${slug(state.site.name)}_${$("#fld-date").value || "draft"}.html`, "text/html", html);
  }
  function downloadJson() {
    download(`ESS_${slug(state.site.name)}_${$("#fld-date").value || "draft"}.json`, "application/json", JSON.stringify(reportObject(), null, 2));
  }
  function copySummary() {
    const r = reportObject();
    const lines = [`ESS — ${r.site.name} (${r.site.state}, ${r.site.station_num || "no station #"})`,
      `Lat/Long: ${r.site.lat}, ${r.site.lon}  ·  Date: ${r.site.assessment_date}`, ""];
    r.sections.forEach((sec) => { if (sec.choice || sec.note) lines.push(`• ${sec.title}: ${sec.choice || ""}${sec.note ? " — " + sec.note : ""}`); });
    lines.push("", "Collection log:");
    r.collection_log.forEach((c) => lines.push(`  [${(STATUS_LABEL[c.status] || c.status).toUpperCase()}] ${c.name}${c.note ? " — " + c.note : ""}`));
    copy(lines.join("\n"));
  }
  function copyAgentPrompt() {
    const s = state.site;
    const idpart = s.station_num ? `station ${s.station_num}` : "no station number";
    copy(
      `Run the ess-collect skill in this repo for ${s.name} (${idpart}, ${s.state || "?"}, ` +
      `lat ${s.lat} lon ${s.lon}). Attempt every source you can reach, assign FOUND / NONE / ` +
      `FAILED / MANUAL with evidence, and output the completed ess-findings/1 JSON ` +
      `(fill in \`python .claude/skills/ess-collect/resolve.py --station "${s.name}" --template\`) ` +
      `so I can import it into the ESS Workbench.`);
  }

  // Build a complete, self-contained, model-agnostic prompt for the current
  // site. Unlike copyAgentPrompt (which drives the in-repo ess-collect skill),
  // this embeds every step, every applicable source aimed at the location, the
  // standardized report wording, and a ready-to-fill ess-findings/1 skeleton —
  // so a user can paste it into ANY LLM/assistant, do the research externally,
  // and hand the JSON straight back into "Import agent findings".
  function buildFullPrompt() {
    const s = state.site;
    const date = ($("#fld-date") && $("#fld-date").value) || state.date || new Date().toISOString().slice(0, 10);
    const list = sourcesForSite();
    const cats = (DATA.sourcesMeta && DATA.sourcesMeta.categories) || [];
    const idpart = s.station_num ? `Bureau station ${s.station_num}` : "manual coordinate entry (no station number)";
    const L = [];

    L.push(`# Environmental Site Summary (ESS) — desktop assessment`, ``);
    L.push(`## Your task`);
    L.push(`You are an environmental desktop-research assistant. Carry out a desk-based Environmental Site Summary for the Australian site below. This is an office/desktop review only — do NOT arrange or assume a site visit. Use the public web pages listed here plus your own web browsing/search to establish what environmental, heritage and biosecurity matters affect the location, then return the single JSON object at the end so the findings can be imported back into the ESS Workbench tool.`);
    L.push(`This prompt is self-contained and model-agnostic: you need no special repository, plugin or API key — a web browser or web-search capability is enough. Work through every source, then produce the JSON.`, ``);

    L.push(`## The site`);
    L.push(`- Station name: ${s.name}`);
    L.push(`- Identifier: ${idpart}${s.wmo ? `, WMO ${s.wmo}` : ""}`);
    L.push(`- State / territory: ${s.state || "unknown"}`);
    if (s.delivery_group) L.push(`- Delivery group: ${s.delivery_group}`);
    const fac = (s.facility_types && s.facility_types.length && s.facility_types.join(", ")) || s.primary_facility;
    if (fac) L.push(`- Facility type(s): ${fac}`);
    L.push(`- Latitude: ${s.lat}`);
    L.push(`- Longitude: ${s.lon}`);
    L.push(`- Assessment date: ${date}`, ``);

    L.push(`## How to record each source`);
    L.push(`Check every source in the list below. For each, choose one status and write a short evidence note:`);
    L.push(`- **found** — the source shows a relevant matter at or near the site (a listed/threatened species or community, heritage place, protected/Indigenous area, declared weed or pest, disease outbreak, PFAS or contamination site, etc.). Say what it is and how close.`);
    L.push(`- **none** — you were able to check and nothing relevant was found. (Each source has an "if nothing found" line explaining what that means.)`);
    L.push(`- **failed** — you tried but could not complete the check (page unreachable, blocked, timed out, errored). Say what stopped you.`);
    L.push(`- **manual** — the check needs a human: an interactive-only map/portal you cannot drive, an internal or login-only system, or a step like drawing a search box. Record the link and the exact steps so a person can finish it fast.`);
    L.push(`Prefer a real answer over "manual" whenever the information is reachable on the open web. Use latitude ${s.lat}, longitude ${s.lon} to place the site precisely, and treat "near" as roughly within 10 km unless a source says otherwise.`, ``);

    L.push(`## Sources to check (${list.length})`);
    for (const cat of cats) {
      const inCat = list.filter((x) => x.category === cat.id).sort((a, b) => (a.priority || 99) - (b.priority || 99));
      if (!inCat.length) continue;
      L.push(``, `### ${cat.label}`);
      inCat.forEach((src) => {
        const flags = [src.jurisdiction === "national" ? "national" : (s.state || "state")];
        if (src.internal) flags.push("internal / login-only");
        if (src.method === "api") flags.push("live-data API");
        else if (src.method === "manual") flags.push("interactive portal");
        else if (src.method === "web_search") flags.push("web search");
        L.push(``, `**${src.name}** _(${flags.join(", ")})_`);
        L.push(`- Open: ${buildUrl(src)}`);
        if (src.what_to_find) L.push(`- Find: ${src.what_to_find}`);
        if (src.instructions) L.push(`- Steps: ${src.instructions}`);
        if (src.id === "epbc-pmst" && DATA.sourcesMeta.epbc_matters)
          L.push(`- Record which of these matter types are returned: ${DATA.sourcesMeta.epbc_matters.join("; ")}.`);
        if (src.web_search) L.push(`- Web-search idea: "${fillTemplate(src.web_search)}"`);
        if (src.no_result_means) L.push(`- If nothing found → \`none\`: ${src.no_result_means}`);
        if (src.internal) L.push(`- Note: internal Bureau of Meteorology system — an external assistant cannot log in, so this is normally \`manual\` (record the link + steps for staff).`);
      });
    }
    L.push(``);

    L.push(`## Report wording — pick the exact standardized phrase`);
    L.push(`For each report section, choose one phrase verbatim from its list (this is the wording the ESS proforma requires). If you are unsure, leave it blank and the tool will suggest one from your source findings.`);
    REPORT_SECTIONS.forEach((sec) => {
      const opts = sec.dropdown ? (DATA.dropdowns[sec.dropdown] || []) : [];
      L.push(``, `**${sec.title}** (id: \`${sec.id}\`)`);
      if (opts.length) opts.forEach((o) => L.push(`  - ${o}`));
      else L.push(`  - (free text — summarise the relevant findings in the note)`);
    });
    L.push(``);

    const skeleton = {
      schema: "ess-findings/1",
      tool: "external-llm",
      site: {
        name: s.name, station_num: s.station_num || "", wmo: s.wmo || "",
        state: s.state || "", delivery_group: s.delivery_group || "",
        facility_types: s.facility_types || [], lat: s.lat, lon: s.lon,
        assessment_date: date, site_maintenance: "",
      },
      sections: REPORT_SECTIONS.map((sec) => ({ id: sec.id, title: sec.title, choice: "", note: "" })),
      collection_log: list.map((src) => ({ id: src.id, name: src.name, url: buildUrl(src), status: "", note: "", result_text: "" })),
    };

    L.push(`## What to return`);
    L.push(`Fill in the JSON object below and return **only** that object — no commentary, no markdown fences — so it can be pasted directly into the tool at "Choose a site → Import agent findings".`);
    L.push(`Rules:`);
    L.push(`- Keep every \`id\` exactly as given; do not add, remove or rename entries in \`collection_log\` or \`sections\`.`);
    L.push(`- In \`collection_log\`, set \`status\` to one of: found, none, failed, manual. Put a one-line evidence summary in \`note\`, and any longer detail (counts, species names, distances, dates) in \`result_text\`.`);
    L.push(`- In \`sections\`, set \`choice\` to one of that section's allowed phrases above (copied verbatim), or leave it "" to let the tool auto-suggest.`);
    L.push(`- Leave the \`site\` block unchanged.`, ``);
    L.push("```json");
    L.push(JSON.stringify(skeleton, null, 2));
    L.push("```");

    return L.join("\n");
  }

  // Briefly flash a button to confirm a click/copy (see .btn.flash in styles.css).
  function flashButton(btn) {
    if (!btn) return;
    btn.classList.remove("flash");
    void btn.offsetWidth; // force reflow so the animation can restart on rapid clicks
    btn.classList.add("flash");
    btn.addEventListener("animationend", () => btn.classList.remove("flash"), { once: true });
  }

  function copyFullPrompt(e) {
    copy(buildFullPrompt());
    flashButton((e && e.currentTarget) || $("#btn-copy-prompt"));
  }

  function doImport() {
    const text = $("#import-text").value.trim();
    const file = $("#import-file").files && $("#import-file").files[0];
    const parse = (raw) => {
      try { importFindings(JSON.parse(raw)); toast("Findings imported"); }
      catch (err) { alert("Import failed: " + err.message); }
    };
    if (file) {
      const r = new FileReader();
      r.onload = () => parse(String(r.result));
      r.onerror = () => alert("Could not read the file.");
      r.readAsText(file);
    } else if (text) {
      parse(text);
    } else {
      alert("Choose a findings file or paste the JSON first.");
    }
  }

  const slug = (s) => s.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").slice(0, 40);
  function copy(text) {
    navigator.clipboard ? navigator.clipboard.writeText(text).then(() => toast("Copied")) : toast("Copy not available");
  }
  let toastTimer;
  function toast(msg) {
    let t = $("#toast");
    if (!t) { t = el("div", { id: "toast", style: "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#17242e;color:#fff;padding:9px 16px;border-radius:8px;z-index:99;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.3)" }); document.body.append(t); }
    t.textContent = msg; t.style.opacity = "1";
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.opacity = "0"; }, 1400);
  }

  // ---------------------------------------------------------------- wiring
  function wire() {
    // tabs
    $$(".tab").forEach((t) => t.addEventListener("click", () => {
      $$(".tab").forEach((x) => x.classList.toggle("is-active", x === t));
      $$(".tab-panel").forEach((p) => p.classList.toggle("is-active", p.dataset.panel === t.dataset.tab));
    }));
    // autocomplete
    const search = $("#station-search");
    search.addEventListener("input", () => renderAcList(searchStations(search.value)));
    search.addEventListener("focus", () => { if (search.value) renderAcList(searchStations(search.value)); });
    search.addEventListener("keydown", (e) => {
      const ul = $("#station-results");
      if (ul.hidden) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        acIndex += e.key === "ArrowDown" ? 1 : -1;
        acIndex = Math.max(0, Math.min(acMatches.length - 1, acIndex));
        $$("#station-results li").forEach((li, i) => li.classList.toggle("active", i === acIndex));
      } else if (e.key === "Enter" && acIndex >= 0) { e.preventDefault(); selectStation(acMatches[acIndex]); }
      else if (e.key === "Escape") ul.hidden = true;
    });
    document.addEventListener("click", (e) => { if (!e.target.closest(".autocomplete")) $("#station-results").hidden = true; });

    $("#load-coords").addEventListener("click", loadCoordSite);
    $("#import-load").addEventListener("click", doImport);
    $("#btn-clear-site").addEventListener("click", () => { $("#workspace").hidden = true; $("#site-picker").scrollIntoView({ behavior: "smooth" }); $("#station-search").focus(); });
    $("#toggle-manual-internal").addEventListener("change", () => { renderDashboard(); renderProgress(); });
    $("#btn-filter-attention").addEventListener("click", () => { state.filterAttention = !state.filterAttention; renderDashboard(); renderAttention(); syncFilterButton(); });
    $("#btn-copy-agent-prompt").addEventListener("click", copyAgentPrompt);
    $("#btn-copy-prompt").addEventListener("click", copyFullPrompt);
    $("#btn-run-auto").addEventListener("click", runAllAuto);
    $("#fld-date").addEventListener("change", save);
    $("#fld-maintenance").addEventListener("input", save);
    $("#btn-print").addEventListener("click", doPrint);
    $("#btn-download-html").addEventListener("click", downloadHtml);
    $("#btn-download-json").addEventListener("click", downloadJson);
    $("#btn-copy-summary").addEventListener("click", copySummary);
  }

  // ---------------------------------------------------------------- init
  async function init() {
    wire();
    try {
      await loadData();
    } catch (err) {
      const local = location.protocol === "file:";
      showBanner("error",
        `<b>Could not load site data.</b> ${esc(err.message)}<br>` +
        (local
          ? `You've opened this file directly. Browsers block <code>fetch()</code> from <code>file://</code>. Serve the folder instead:<br><code>cd ess &amp;&amp; python3 -m http.server 8000</code> then open <code>http://localhost:8000/</code> — or publish via GitHub Pages.`
          : `Check that <code>data/stations.json</code>, <code>sources.json</code>, <code>dropdowns.json</code> and <code>meta.json</code> are present.`));
      return;
    }
    $("#station-count-hint").textContent =
      `${DATA.stations.length.toLocaleString()} Bureau sites · ${DATA.sources.length} sources · data ${DATA.meta.generated_utc ? DATA.meta.generated_utc.slice(0, 10) : ""}`;
    $("#foot-meta").textContent = `${DATA.stations.length.toLocaleString()} sites · ${DATA.sources.length} sources.`;
    $("#station-search").focus();
    document.dispatchEvent(new CustomEvent("ess:ready")); // signals the optional agent module
  }

  // ------------------------------------------------- integration API (agent.js)
  // Minimal surface the optional BYOK agent module uses to read the site + its
  // sources and write results into the same review/export state. If agent.js
  // isn't loaded, none of this runs.
  const VALID_STATUS = new Set(["found", "none", "failed", "manual", "unset"]);
  window.ESS = {
    ready: () => !!state.site,
    site: () => state.site && { name: state.site.name, station_num: state.site.station_num, wmo: state.site.wmo,
      state: state.site.state, delivery_group: state.site.delivery_group, facility_types: state.site.facility_types,
      lat: state.site.lat, lon: state.site.lon },
    sources: () => sourcesForSite().map((s) => ({
      id: s.id, name: s.name, category: s.category, jurisdiction: s.jurisdiction, method: s.method,
      internal: !!s.internal, url: buildUrl(s), what_to_find: s.what_to_find || "",
      web_search: fillTemplate(s.web_search || ""), is_ala: !!(s.api && s.api.kind === "ala_biocache"),
      no_result_means: s.no_result_means || "",
    })),
    setResult: (id, status, note, resultText) => {
      if (!DATA.sources.find((x) => x.id === id) || !VALID_STATUS.has(status)) return false;
      const f = state.findings[id] || (state.findings[id] = {});
      f.status = status;
      if (note != null) f.note = String(note);
      if (resultText) f.result = { html: esc(String(resultText)).replace(/\n/g, "<br>"), ts: Date.now() };
      save(); refreshCard(id); renderProgress(); renderReport();
      return true;
    },
    queryAla: (radius) => alaQuery(state.site.lat, state.site.lon, radius || 10),
    beginRun: () => { state.showAttention = false; renderAttention(); },
    endRun: () => { state.showAttention = true; renderProgress(); },
  };

  document.addEventListener("DOMContentLoaded", init);
})();
