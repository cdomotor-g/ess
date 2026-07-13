/* ESS Workbench — optional BYOK in-browser agent (beta).
 *
 * Runs the whole ESS desktop assessment from the browser using the user's OWN
 * Anthropic API key. Claude drives the loop with Anthropic's server-side
 * web_search / web_fetch tools (which run on Anthropic's infra, so they bypass
 * browser CORS) plus two client-side tools this file executes: query_ala (hits
 * the Atlas of Living Australia) and set_source_result (writes each finding into
 * the shared review/export state via window.ESS). Results fill the dashboard
 * live; the same reviewer/export surface then applies.
 *
 * Nothing here runs unless the user opens the Agent panel and adds a key. The
 * key is stored only in this browser's localStorage and is sent only to
 * api.anthropic.com. No backend, no shared/default key (see docs/ROADMAP.md for
 * the proxy path that would enable a shared key).
 */
(() => {
  "use strict";

  // Swap API_BASE to a proxy origin to route through a server that holds a
  // shared key (see docs/ROADMAP.md → default-key proxy). BYOK talks direct.
  const API_BASE = "https://api.anthropic.com";
  const API_VERSION = "2023-06-01";
  const LS_KEY = "ess-workbench:v1:anthropic-key";
  const LS_MODEL = "ess-workbench:v1:agent-model";
  const MAX_TURNS = 80;
  const MAX_TOKENS = 8192;

  // model id -> { label, search tool version, fetch tool version|null, $per 1M }
  const MODELS = {
    "claude-opus-4-8": { label: "Opus 4.8 — best quality", search: "web_search_20260209", fetch: "web_fetch_20260209", in: 5, out: 25 },
    "claude-haiku-4-5": { label: "Haiku 4.5 — cheaper/faster", search: "web_search_20250305", fetch: null, in: 1, out: 5 },
  };

  const $ = (s, r = document) => r.querySelector(s);
  const h = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else if (v != null && v !== false) n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
    return n;
  };

  const getKey = () => { try { return localStorage.getItem(LS_KEY) || ""; } catch (_) { return ""; } };
  const getModel = () => { try { return localStorage.getItem(LS_MODEL) || "claude-opus-4-8"; } catch (_) { return "claude-opus-4-8"; } };

  let running = false;

  // ---------------------------------------------------------------- panel UI
  function buildPanel() {
    const panel = $("#agent-panel");
    panel.innerHTML = "";
    const keyVal = getKey();
    const model = getModel();

    const keyInput = h("input", { type: "password", id: "agent-key", placeholder: "sk-ant-…", value: keyVal, autocomplete: "off", spellcheck: "false" });
    const modelSel = h("select", { id: "agent-model" });
    for (const [id, cfg] of Object.entries(MODELS)) modelSel.append(h("option", { value: id, selected: id === model ? "selected" : null }, cfg.label));

    panel.append(
      h("div", { class: "card-head", style: "margin-bottom:8px" },
        h("h2", {}, "🔑 Run assessment with Claude ", h("span", { class: "beta" }, "beta · your key")),
        h("button", { class: "btn ghost tiny", onclick: () => { panel.hidden = true; } }, "Close")),
      h("p", { class: "warn" },
        "Bring your own Anthropic API key. It is stored only in this browser (localStorage) and sent only to api.anthropic.com — never to any other server. ",
        "Claude works through every source using Anthropic's web search/fetch tools and fills the dashboard; you then review the Manual/Failed items and export. Each run costs a few cents to your key. Use a limited key."),
      h("div", { class: "agent-row" },
        h("div", {}, h("label", { class: "field-label", for: "agent-key" }, "Anthropic API key"), keyInput),
        h("div", { style: "flex:0 0 auto;min-width:170px" }, h("label", { class: "field-label", for: "agent-model" }, "Model"), modelSel)),
      h("div", { class: "agent-row", style: "margin-top:4px" },
        h("button", { class: "btn primary", onclick: saveKey }, "Save key"),
        h("button", { class: "btn ghost", onclick: clearKey }, "Clear key"),
        h("button", { class: "btn", id: "agent-run-2", onclick: runAgent }, "⚡ Run full assessment"),
        h("a", { class: "btn ghost", href: "docs/AGENT-MODE.md", target: "_blank", rel: "noopener" }, "How it works ↗")),
      h("div", { class: "agent-status", id: "agent-status" }, keyVal ? "Key saved in this browser." : "No key saved yet."),
    );
    reflectRunning();
  }

  function saveKey() {
    const v = $("#agent-key").value.trim();
    const m = $("#agent-model").value;
    try { v ? localStorage.setItem(LS_KEY, v) : localStorage.removeItem(LS_KEY); localStorage.setItem(LS_MODEL, m); } catch (_) {}
    setStatus(v ? "Key saved in this browser." : "Key cleared.");
  }
  function clearKey() {
    try { localStorage.removeItem(LS_KEY); } catch (_) {}
    const k = $("#agent-key"); if (k) k.value = "";
    setStatus("Key cleared.");
  }
  function openPanel() { const p = $("#agent-panel"); if (p) { p.hidden = false; p.scrollIntoView({ behavior: "smooth", block: "center" }); } }
  function setStatus(msg, err) { const s = $("#agent-status"); if (s) { s.textContent = msg; s.className = "agent-status" + (err ? " err" : ""); } }

  function reflectRunning() {
    const b1 = $("#btn-run-agent"), b2 = $("#agent-run-2");
    [b1, b2].forEach((b) => { if (b) { b.disabled = running; } });
    if (b1) b1.innerHTML = running ? '<span class="spin"></span> Agent running…' : "🤖 Run agent";
  }

  // ---------------------------------------------------------------- the run
  async function runAgent() {
    if (running) return;
    const key = getKey() || ($("#agent-key") && $("#agent-key").value.trim());
    if (!key) { openPanel(); setStatus("Add your Anthropic API key first, then Save.", true); return; }
    if (!window.ESS || !window.ESS.ready()) { alert("Load a site first (by name or coordinates)."); return; }
    const site = window.ESS.site();
    const sources = window.ESS.sources();
    const model = getModel();
    const cfg = MODELS[model] || MODELS["claude-opus-4-8"];

    running = true; reflectRunning(); openPanel();
    window.ESS.beginRun();
    const usage = { in: 0, out: 0, cr: 0, cw: 0 };

    const system = [{ type: "text", text: systemPrompt(site, sources, cfg), cache_control: { type: "ephemeral" } }];
    const tools = buildTools(cfg, sources);
    const messages = [{ role: "user", content: "Begin the assessment now. Work through every source in the list, record each with set_source_result, then stop." }];

    try {
      for (let turn = 1; turn <= MAX_TURNS && running; turn++) {
        setStatus(`Assessing… turn ${turn} · ${costLine(usage, cfg)}`);
        const resp = await callApi(key, { model, system, tools, messages });
        accUsage(usage, resp.usage);

        if (resp.stop_reason === "refusal") { setStatus("Claude declined this request. " + refusalText(resp), true); break; }
        messages.push({ role: "assistant", content: resp.content });
        if (resp.stop_reason === "end_turn") { setStatus(`Done. ${remainingLine()} · ${costLine(usage, cfg)}`); break; }
        if (resp.stop_reason === "pause_turn") { continue; } // server tools mid-flight — re-send to continue

        if (resp.stop_reason === "tool_use") {
          const results = [];
          for (const block of resp.content) {
            if (block.type !== "tool_use") continue;
            results.push(await handleClientTool(block));
          }
          if (!results.length) { setStatus("Stopped: model paused without a client tool call.", true); break; }
          messages.push({ role: "user", content: results });
          continue;
        }
        if (resp.stop_reason === "max_tokens") { setStatus("Stopped: hit the per-turn token cap.", true); break; }
        break; // unknown stop reason
      }
    } catch (err) {
      setStatus(errorHint(err), true);
    } finally {
      running = false; reflectRunning();
      window.ESS.endRun();
    }
  }

  async function handleClientTool(block) {
    const id = block.id, name = block.name, input = block.input || {};
    if (name === "query_ala") {
      try {
        const r = await window.ESS.queryAla(Number(input.radius) || 10);
        return toolResult(id, r.text || "No ALA summary.");
      } catch (e) { return toolResult(id, "ALA query failed (network/CORS): " + e.message, true); }
    }
    if (name === "set_source_result") {
      const ok = window.ESS.setResult(input.id, input.status, input.note, input.result_text, input.image_subjects);
      return toolResult(id, ok ? "recorded" : `error: unknown source id or invalid status (${input.id} / ${input.status})`, !ok);
    }
    return toolResult(id, "unsupported tool: " + name, true);
  }

  const toolResult = (tool_use_id, content, is_error) => ({ type: "tool_result", tool_use_id, content: String(content), ...(is_error ? { is_error: true } : {}) });

  // ---------------------------------------------------------------- API call
  async function callApi(key, { model, system, tools, messages }) {
    const res = await fetch(API_BASE + "/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": API_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system, tools, messages, output_config: { effort: "medium" } }),
    });
    if (!res.ok) {
      let detail = "";
      try { const j = await res.json(); detail = (j.error && j.error.message) || JSON.stringify(j); } catch (_) { detail = await res.text().catch(() => ""); }
      const e = new Error(`HTTP ${res.status}: ${String(detail).slice(0, 300)}`); e.status = res.status; throw e;
    }
    return res.json();
  }

  // ---------------------------------------------------------------- prompt/tools
  function systemPrompt(site, sources, cfg) {
    const lines = sources.map((s, i) => {
      const tags = [s.is_ala ? "USE query_ala" : null, s.internal ? "INTERNAL (needs Bureau login → manual)" : null].filter(Boolean);
      return `${i + 1}. [${s.id}] ${s.name} (${s.category}, ${s.jurisdiction})${tags.length ? " — " + tags.join("; ") : ""}\n   what to find: ${s.what_to_find}\n   url: ${s.url}`;
    }).join("\n");
    const fetchLine = cfg.fetch ? "web_search and web_fetch" : "web_search";
    return [
      "You are completing the desktop-research stage of a Bureau of Meteorology Environmental Site Summary (ESS).",
      `SITE: ${site.name} — station ${site.station_num || "—"}, WMO ${site.wmo || "—"}, ${site.state || "?"}, lat ${site.lat}, lon ${site.lon}.`,
      "",
      `For EVERY source in the list below, decide a result and record it by calling set_source_result exactly once for that source id. Use ${fetchLine} to research each source's URL and "what to find". For the Atlas of Living Australia source, call query_ala instead of searching (it returns structured conservation data for this site).`,
      "",
      "Assign exactly one status per source:",
      "- found: the source has something relevant. Put specifics (species, listing names/IDs, outbreak names, lease conditions) in note, and the raw detail in result_text.",
      "- none: you successfully checked and found nothing relevant.",
      "- failed: you tried but could not get an answer (blocked, error, unreachable, no data at the URL).",
      "- manual: the source needs a human — an interactive/draw-a-polygon map (e.g. EPBC Protected Matters), an INTERNAL SharePoint page, or a portal with no readable data at the URL. Put the aimed link + the steps in note; do NOT invent a result.",
      "",
      "For species/subject sources (categories invasive_plants, invasive_animals, disease, threatened) that you mark FOUND, also fill image_subjects with the identifiable species/subject names you found (common or scientific, e.g. \"Gamba grass\", \"Phytophthora cinnamomi\") — the tool auto-fetches a labelled reference photo for each. Leave it empty for non-species sources and for none/failed/manual.",
      "",
      "Rules: never leave a source unrecorded. Be honest — 'none' (checked, absent) and 'failed' (unknown) are different and both matter. Record specifics, not just yes/no. Don't fabricate. The EPBC Protected Matters Search Tool has no API — record it as manual with the 50 km-buffer steps. When every source has been recorded, briefly summarise and stop.",
      "",
      "SOURCES:",
      lines,
    ].join("\n");
  }

  function buildTools(cfg, sources) {
    const ids = sources.map((s) => s.id);
    const tools = [{ type: cfg.search, name: "web_search", max_uses: 25 }];
    if (cfg.fetch) tools.push({ type: cfg.fetch, name: "web_fetch", max_uses: 25 });
    tools.push({
      name: "query_ala",
      description: "Query the Atlas of Living Australia for conservation-listed flora & fauna near this site. Use for the Atlas of Living Australia source.",
      input_schema: { type: "object", properties: { radius: { type: "number", description: "search radius in km (default 10)" } } },
    });
    tools.push({
      name: "set_source_result",
      description: "Record the result for one ESS source. Call once per source id.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", enum: ids, description: "the source id from the list" },
          status: { type: "string", enum: ["found", "none", "failed", "manual"] },
          note: { type: "string", description: "one-line finding, or the steps for a manual source" },
          result_text: { type: "string", description: "raw detail / evidence (optional)" },
          image_subjects: { type: "array", items: { type: "string" },
            description: "Only for FOUND species/subject sources (invasive plants, invasive animals, disease, threatened): identifiable species/subject names (common or scientific) — the tool fetches a labelled reference photo for each. Omit otherwise." },
        },
        required: ["id", "status", "note"],
      },
    });
    return tools;
  }

  // ---------------------------------------------------------------- helpers
  function accUsage(u, usage) {
    if (!usage) return;
    u.in += usage.input_tokens || 0;
    u.out += usage.output_tokens || 0;
    u.cr += usage.cache_read_input_tokens || 0;
    u.cw += usage.cache_creation_input_tokens || 0;
  }
  function costLine(u, cfg) {
    const dollars = (u.in * cfg.in + u.out * cfg.out + u.cr * cfg.in * 0.1 + u.cw * cfg.in * 1.25) / 1e6;
    const toks = u.in + u.out + u.cr + u.cw;
    return `${toks.toLocaleString()} tokens · ~$${dollars.toFixed(3)}`;
  }
  function remainingLine() {
    try {
      const srcs = window.ESS.sources();
      return `${srcs.length} sources processed`;
    } catch (_) { return ""; }
  }
  function refusalText(resp) { return (resp.stop_details && resp.stop_details.explanation) || ""; }
  function errorHint(err) {
    const s = err.status;
    if (s === 401) return "Invalid API key (401). Check the key and Save again.";
    if (s === 403) return "Key lacks permission (403), or your org blocks browser access.";
    if (s === 429) return "Rate limited (429). Wait a moment and retry.";
    if (s >= 500) return "Anthropic service error (" + s + "). Retry shortly.";
    if (/Failed to fetch|NetworkError|CORS/i.test(err.message)) return "Network/CORS error reaching api.anthropic.com. Check your connection; the browser-access header is set automatically.";
    return "Error: " + err.message;
  }

  // ---------------------------------------------------------------- wire-up
  function activate() {
    const settingsBtn = $("#btn-agent-settings");
    const runBtn = $("#btn-run-agent");
    if (settingsBtn) { settingsBtn.hidden = false; settingsBtn.addEventListener("click", () => { const p = $("#agent-panel"); if (p.hidden) { p.hidden = false; p.scrollIntoView({ behavior: "smooth", block: "center" }); } else { p.hidden = true; } }); }
    if (runBtn) { runBtn.hidden = false; runBtn.addEventListener("click", runAgent); }
    buildPanel();
  }

  // app.js dispatches ess:ready once data + window.ESS are available.
  if (window.ESS && window.ESS.ready) activate();
  else document.addEventListener("ess:ready", activate, { once: true });
})();
