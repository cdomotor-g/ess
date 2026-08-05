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
  // Source categories where a site photo is useful evidence (weeds, pests, disease,
  // listed species, biosecurity, heritage) — these get an "evidence photo" dropzone.
  const PHOTO_CATEGORIES = new Set(["invasive_plants", "invasive_animals", "disease", "threatened", "biosecurity", "indigenous_heritage"]);
  // Categories that are about identifiable species/subjects, where auto-sourcing a
  // reference photo from Wikipedia (weed, feral animal, pathogen) makes sense.
  const WIKI_IMAGE_CATEGORIES = new Set(["invasive_plants", "invasive_animals", "disease", "threatened"]);
  // Per-category placeholder / example subjects for the "reference image" field.
  const WIKI_PLACEHOLDER = {
    invasive_plants: "e.g. Gamba grass, Parthenium…",
    invasive_animals: "e.g. Feral pig, Cane toad…",
    disease: "e.g. Myrtle rust, Phytophthora cinnamomi…",
    threatened: "e.g. Koala, Wollemi pine…",
  };

  // The Queensland Globe site map (assets/qldmap.js) owns the layer catalogue —
  // it is the thing that has to resolve each layer against the live QLD
  // services, so it is also the only sensible place for the list to live. app.js
  // just persists which layers were ticked and what the capture recorded.

  // Global preference: auto-source reference photos for the species/subjects
  // identified in a card's findings (from note edits, imports, and agent runs).
  // Persisted in localStorage; default on. Auto-fetch only ever *adds* images —
  // the user can delete any, and the manual "Fetch image" field always works.
  const LS_AUTO_IMAGES = "ess-workbench:v1:auto-images";
  // Batch membership (the list of sites imported together). Only the site keys +
  // display info live here; each site's full findings stay under its own per-site
  // key (siteKey), so a batch is just an index over storage that already exists.
  const LS_BATCH = "ess-workbench:v1:batch";
  // The "how to work through the list" guide is onboarding, not chrome: it is shown
  // expanded on a first visit and never again by default once the operator has
  // finished a site (it stays one ? away in the collection header). This flag is
  // what "has finished a site" means — see markOnboarded. The older key recorded
  // whether the same guide was left open; an operator who had already collapsed it
  // has plainly read it, so it seeds the new flag rather than being dropped.
  const LS_ONBOARDED = "ess-workbench:v1:onboarded";
  const LS_GUIDE = "ess-workbench:v1:dash-guide";
  // Whether the site-details panel (the full station record, map controls and the
  // photo dropzone) is left open. Closed by default: step 2 is a check, and the
  // header above the panel already carries everything that check needs.
  const LS_SITE_DETAILS = "ess-workbench:v1:site-details-open";
  // Dashboard card ordering: "attention" (default) or "source" (registry order).
  // A browser preference rather than per-site state — it's a way of working, and an
  // operator who wants the stable registry order wants it on every site.
  const LS_CARD_SORT = "ess-workbench:v1:card-sort";
  // Whether the Advanced options card at the foot of the left column is left open.
  // Closed by default: the four numbered steps are the whole primary workflow, and
  // everything in there belongs to a different way of working.
  const LS_ADVANCED = "ess-workbench:v1:advanced-open";
  // Default OFF: auto-fetching reference photos fires a burst of Wikipedia requests
  // + canvas re-encoding, which was bogging the browser down. It now runs only when
  // the operator opts in via the dashboard toggle (and even then only on import /
  // agent / API runs — never as a side effect of editing a card's notes).
  const autoImagesOn = () => { try { return localStorage.getItem(LS_AUTO_IMAGES) === "1"; } catch (_) { return false; } };
  const setAutoImagesPref = (on) => { try { localStorage.setItem(LS_AUTO_IMAGES, on ? "1" : "0"); } catch (_) {} };
  const MAX_AUTO_IMAGES_PER_CARD = 3; // cap per source so a wordy note can't spam fetches

  // Default free-text seeded into a report section's note when a site is first
  // loaded (only if the operator hasn't written anything there yet). The general
  // biosecurity obligation (GBO) under Queensland's Biosecurity Act 2014 applies
  // to every QLD site, so it's pre-filled into the Biosecurity section for QLD —
  // it flows straight into the exported report unless the operator edits it out.
  const GBO_BIOSECURITY_TEXT =
    "Under the Biosecurity Act 2014, everyone in Queensland has a general biosecurity obligation (GBO) to ensure that they do not spread a pest, disease or a contaminant. We are all responsible for managing biosecurity risks that are under our control.\n\n" +
    "Under the GBO, individuals and corporations whose activities pose a biosecurity risk must:\n\n" +
    "•  take all reasonable and practical steps to prevent or minimise each biosecurity risk\n" +
    "•  minimise the likelihood of causing a biosecurity event, and limit the consequences if an event is caused\n" +
    "• prevent or minimise the harmful effects a risk could have, and not do anything that might make any harmful effects worse.\n\n" +
    "Even if you are permitted to access places under an Act, you still have a GBO to minimise biosecurity risks.";
  // Section-note defaults, applied by newReportState() when a report section is
  // first created for a site. State-aware where a default is jurisdiction-specific.
  function defaultSectionNote(sectionId) {
    if (sectionId === "biosecurity" && state.site && state.site.state) {
      // QLD keeps its established wording; other jurisdictions get their own
      // general-biosecurity-obligation text from statements.json when available.
      if (state.site.state === "QLD") return GBO_BIOSECURITY_TEXT;
      const gbo = (DATA.statements && DATA.statements.general_biosecurity_obligation) || {};
      return gbo[state.site.state] || gbo["*"] || "";
    }
    return "";
  }
  function newReportState(sectionId) { return { choice: null, note: defaultSectionNote(sectionId) }; }

  // ---------------------------------------------------------------- site map
  // TWO satellite locator maps are auto-generated for every site: a hyper-local
  // one (default 10 km across) for the immediate surrounds and a greater-region
  // one (default 250 km) for context. Tiles are fetched from Esri World Imagery
  // (keyless, CORS-enabled), stitched onto a canvas with a pin at the station
  // coordinates, and kept as self-contained JPEG data URLs — so they persist in
  // localStorage and travel through the report + every export exactly like the
  // station photos do. Both are carried into the report side by side.
  const MAP_MIN_KM = 1, MAP_MAX_KM = 2000;
  // Per-slot config: two independent maps, each with its own size + presets.
  const MAP_SLOTS = [
    { key: "local",  title: "Hyper-local map",   note: "close surrounds", defaultKm: 10,  presets: [1, 5, 10, 25, 50] },
    { key: "region", title: "Greater-region map", note: "regional context", defaultKm: 250, presets: [50, 100, 250, 500, 1000] },
  ];
  const MAP_SLOT_BY_KEY = Object.fromEntries(MAP_SLOTS.map((s) => [s.key, s]));
  const MAP_DEFAULT_KM = MAP_SLOTS[0].defaultKm; // legacy single-map fallback (import of old files)
  const MAP_PX = 900;              // rendered square size (px) of the map image
  // Fresh per-slot map state for a new site. Declared (not arrow) so it's hoisted
  // above the `state` initializer that calls it.
  function freshMaps() {
    const m = {};
    for (const slot of MAP_SLOTS) m[slot.key] = { km: slot.defaultKm, labels: true, image: null, status: "idle", error: "" };
    return m;
  }
  const MAP_MIN_ZOOM = 3, MAP_MAX_ZOOM = 19;
  const MAP_TILE_TIMEOUT = 9000;   // per-tile load timeout (ms)
  const MERCATOR_M_PER_PX0 = 156543.03392; // ground metres/pixel at zoom 0, equator
  const MAP_ATTRIB = "Imagery © Esri, Maxar, Earthstar Geographics";
  const MAP_REF_ATTRIB = "Roads & places © Esri, HERE, Garmin"; // credit for the overlay layers
  // Esri World Imagery tiled basemap — URL order is /{z}/{y}/{x}. Sends
  // Access-Control-Allow-Origin, so tiles fetched with crossOrigin stay
  // canvas-exportable (toDataURL won't taint).
  const mapTileUrl = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
  // Transparent Esri "reference" overlays on the SAME host/CDN as the imagery
  // above — so they carry the identical CORS headers and stay canvas-exportable.
  // World_Transportation draws roads/rail; World_Boundaries_and_Places draws
  // locality/place labels and admin boundaries. Composited over the imagery (in
  // this order, labels last so text sits on top) when the "Roads & labels"
  // toggle is on, giving the satellite locator readable road + place context.
  const MAP_REF_LAYERS = [
    (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/${z}/${y}/${x}`,
    (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}`,
  ];

  // State-specific tool lookups need the state a coordinate is actually in, not
  // an administrative guess — so resolve it against real state boundary polygons
  // (data/reference/au_states.geojson, loaded into DATA.stateBoundaries by
  // loadReference()) with a point-in-polygon test, mirroring build/geostate.py.
  // Natural Earth admin-1 feature names -> the state code sources are keyed on.
  const STATE_NAME_TO_CODE = {
    "Western Australia": "WA", "Northern Territory": "NT", "South Australia": "SA",
    "Queensland": "QLD", "New South Wales": "NSW", "Victoria": "VIC", "Tasmania": "TAS",
    "Australian Capital Territory": "ACT",
    "Jervis Bay Territory": "NSW", "Lord Howe Island": "NSW",
    "Macquarie Island": "TAS", "Ashmore and Cartier Islands": "WA",
  };
  // Last-resort fallback only, for when the boundary file hasn't loaded (or a
  // point falls outside its coverage). Heuristic, boxes overlap near borders.
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
  function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function pointInPolygon(x, y, poly) {
    if (!pointInRing(x, y, poly[0])) return false;
    return !poly.slice(1).some((hole) => pointInRing(x, y, hole));
  }
  // Cap on the nearest-vertex fallback, in degrees — see build/geostate.py.
  const NEAREST_MAX_DEG = 3.0;
  function nearestStateFromBoundaries(x, y) {
    let bestCode = "", bestD2 = Infinity;
    for (const { code, polys } of DATA.stateBoundaries) {
      for (const poly of polys) for (const ring of poly) for (const pt of ring) {
        const d2 = (pt[0] - x) ** 2 + (pt[1] - y) ** 2;
        if (d2 < bestD2) { bestD2 = d2; bestCode = code; }
      }
    }
    return bestD2 <= NEAREST_MAX_DEG * NEAREST_MAX_DEG ? bestCode : "";
  }
  function stateFromCoords(lat, lon) {
    if (lat == null || lon == null || isNaN(lat) || isNaN(lon)) return "";
    if (DATA.stateBoundaries && DATA.stateBoundaries.length) {
      for (const { code, polys } of DATA.stateBoundaries)
        for (const poly of polys)
          if (pointInPolygon(lon, lat, poly)) return code;
      const nearest = nearestStateFromBoundaries(lon, lat);
      if (nearest) return nearest;
    }
    for (const [code, s, n, w, e] of STATE_BBOXES)
      if (lat >= s && lat <= n && lon >= w && lon <= e) return code;
    return "";
  }

  // ---------------------------------------------------------------- app state
  const DATA = { stations: [], sources: [], sourcesMeta: null, dropdowns: null, meta: null, weeds: [], stateBoundaries: [], statements: {} };
  const state = {
    site: null,        // { name, station_num, wmo, state, delivery_group, facility_types, lat, lon, refs, primary_facility, manual }
    findings: {},      // sourceId -> { status, note, result, images: [{id,dataUrl,caption,ts}] }
    report: {},        // sectionId -> { choice, note }
    siteImages: [],    // [{id, dataUrl, caption, ts}] — general station photos
    // Two independent locator maps keyed by slot (see MAP_SLOTS). Each slot:
    //   { km, labels, image: {dataUrl,km,zoom,labels,lat,lon,ts}|null, status, error }
    // km/labels are persisted (text key); image is persisted (image key); status/
    // error are transient. freshMaps() seeds the defaults for a new site.
    maps: freshMaps(),
    // Queensland Globe site map (QLD sites only): which layers are ticked, and
    // the record of the last capture added to the report. `capture.layers` is
    // what the report appendix lists — deliberately kept out of the picture and
    // out of the report body, because there are far too many layers for either.
    qldMap: { selection: null, capture: null },
    date: "",
    maintenance: "",
    // ONE dashboard filter, one value — see FILTERS. The four segments on the
    // collection bar are the everyday values; the per-result ones live behind that
    // bar's "Results" disclosure. Persisted per site, so returning to a site keeps
    // your place. Never two filters at once: that is what made "what's left"
    // answerable four different ways.
    filter: "all",
    // Dashboard ordering: "attention" (default — what still needs a human first) or
    // "source" (the registry order). A browser-wide preference, not per site.
    cardSort: "attention",
    // Step 3's three sub-steps: which of them this site has already had done.
    // Only the next un-run one carries a filled button (see syncFlowSteps), so
    // the card answers "what now" once instead of three times. Persisted per
    // site alongside the filter and the group collapses.
    flow: { auto: false, prompt: false, applied: false },
    // Per-category collapse, but ONLY where the operator has said so explicitly:
    // catId -> true (open) / false (collapsed). Categories they haven't touched
    // follow the automatic rule in groupIsOpen(). Persisted per site.
    groupOpen: {},
    batch: null,            // { generated, keys: [siteKey,…], active: siteKey|null } when a batch is loaded
  };
  const mapGenTokens = {}; // per-slot guard against a stale async render landing after a newer request
  const cardNumbers = {}; // sourceId -> position in the currently-rendered (filtered) dashboard list

  // ------------------------------------------------------- one status vocabulary
  // "Still needs you" has exactly ONE definition in this app: Manual, Search failed
  // or Not checked. The collection bar, the four filter segments, the nav-rail
  // badges and the per-category roll-ups all count it with statusOf/isOutstanding,
  // so the pane can never again read "100% checked" and "11 still need you" at the
  // same time.
  const ATTENTION = ["manual", "failed", "unset"]; // statuses a human still owns
  const statusOf = (f) => (f && f.status) || STATUS.UNSET;
  const isOutstanding = (f) => ATTENTION.includes(statusOf(f));
  // The operator's own sign-off. Deliberately a different word from the report
  // pane's "Reviewed": they are separate tallies and were previously rendered with
  // pixel-identical controls.
  const isSignedOff = (f) => !!(f && f.reviewed);

  // The dashboard's single filter. `seg: true` puts it on the segmented control in
  // the bar; the rest are the per-result values behind its "Results" disclosure.
  // `empty` is what the list says when the filter matches nothing.
  const FILTERS = {
    attention: { seg: true, label: "Needs you", test: isOutstanding, count: (l) => l.filter(isOutstanding).length,
      empty: "✓ Nothing needs you — every source has an answer." },
    answered:  { seg: true, label: "Answered", test: (f) => !isOutstanding(f), count: (l) => l.filter((f) => !isOutstanding(f)).length,
      empty: "Nothing answered yet — start with the sources that need you." },
    signed:    { seg: true, label: "Signed off", test: isSignedOff, count: (l) => l.filter(isSignedOff).length,
      empty: "Nothing signed off yet." },
    all:       { seg: true, label: "All", test: () => true, count: (l) => l.length, empty: "No sources for this site." },
    found:  { label: "Found", test: (f) => statusOf(f) === "found", empty: 'No sources marked "Found".' },
    none:   { label: "Nothing found", test: (f) => statusOf(f) === "none", empty: 'No sources marked "Nothing found".' },
    failed: { label: "Search failed", test: (f) => statusOf(f) === "failed", empty: 'No sources marked "Search failed".' },
    manual: { label: "Needs manual check", test: (f) => statusOf(f) === "manual", empty: 'No sources marked "Needs manual check".' },
    unset:  { label: "Not checked", test: (f) => statusOf(f) === "unset", empty: "Everything has been checked." },
  };
  const activeFilter = () => FILTERS[state.filter] || FILTERS.all;

  // ------------------------------------------------------- density + ordering
  // A card is rendered at one of three densities, derived from state alone —
  // never from what has been clicked open:
  //
  //   line     ~36 px  reviewed: the operator has ticked it off. Settled.
  //   summary  ~120 px answered (Found / Nothing) but not yet reviewed.
  //   full     ~260 px Manual / Failed / Not checked — a human still owns it.
  //
  // Twelve of a typical site's 23 cards are settled work; at full weight they were
  // ~5,000 px of "already done" between the operator and the next thing that isn't.
  function cardDensity(f) {
    if (isOutstanding(f)) return "full";
    return isSignedOff(f) ? "line" : "summary";
  }
  // Default ordering within a category: the operator's next action first, settled
  // work last. Ties fall back to the registry's own priority, so the order inside a
  // rank is still the one data/sources.json asks for.
  const ATTENTION_RANK = { unset: 0, failed: 1, manual: 2, found: 3, none: 4 };
  function attentionRank(f) {
    if (isSignedOff(f)) return 9; // signed-off sinks below every result still open
    const r = ATTENTION_RANK[statusOf(f)];
    return r === undefined ? 5 : r;
  }
  function sortCards(list) {
    const byPriority = (a, b) => (a.priority || 99) - (b.priority || 99);
    if (state.cardSort !== "attention") return list.sort(byPriority);
    return list.sort((a, b) =>
      (attentionRank(state.findings[a.id]) - attentionRank(state.findings[b.id])) || byPriority(a, b));
  }
  // Any dashboard filter narrows what's on screen to a deliberate subset, so the
  // automatic "this category is finished, fold it away" rule steps aside while one
  // is on — otherwise filtering to Found would fold every group the filter just
  // built.
  function anyFilterOn() {
    return state.filter !== "all";
  }

  // ------------------------------------------------------------------- ui mode
  // Two presentations of ONE state (see the Focus mode section further down, and
  // docs/ARCHITECTURE.md):
  //
  //   focus      (default) one column, one step per screen, the tool proposing
  //                        what comes next
  //   workbench            today's split view — both panes, the operator choosing
  //
  // A preference about how a person works rather than a property of a station, so
  // it lives in the browser and not in the per-site payload — same pattern as
  // LS_ADVANCED / LS_CARD_SORT above.
  const LS_MODE = LS_PREFIX + "mode";
  let uiMode = "focus";
  const focusLive = () => uiMode === "focus";
  const workbenchLive = () => uiMode === "workbench";

  // While Focus is live the workbench's two columns are EMPTIED, not hidden: their
  // children move into these detached holders, and the two purely-derived regions
  // (the dashboard and the report sections) are dropped entirely and rebuilt from
  // state on the way back. Event listeners ride on the nodes themselves, so nothing
  // needs re-wiring in either direction.
  const WB_COLS = ["col-left", "col-right"];
  let wbStash = null; // { "col-left": <div>, "col-right": <div> } | null

  // …with one wrinkle. Plenty of code READS a control rather than rendering into
  // one — sourcesForSite() reads #toggle-manual-internal on every single recompute,
  // including the ones Focus mode does — and those lookups have to keep resolving
  // while the workbench is stashed. So a document-rooted query that misses falls
  // through to the holders. A query with an explicit root never does: that caller
  // has already said which subtree it means.
  const $ = (sel, root = document) => {
    const hit = root.querySelector(sel);
    return hit || (root === document ? stashQuery(sel) : null);
  };
  const $$ = (sel, root = document) => {
    const hits = Array.from(root.querySelectorAll(sel));
    return (hits.length || root !== document) ? hits : stashQueryAll(sel);
  };
  function stashQuery(sel) {
    if (!wbStash) return null;
    for (const id of WB_COLS) {
      const hit = wbStash[id] && wbStash[id].querySelector(sel);
      if (hit) return hit;
    }
    return null;
  }
  function stashQueryAll(sel) {
    if (!wbStash) return [];
    const out = [];
    for (const id of WB_COLS) if (wbStash[id]) out.push(...wbStash[id].querySelectorAll(sel));
    return out;
  }
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

  // ------------------------------------------------------------- source monograms
  // A generated 2-letter tile per source — recognisable at a glance, no network, no
  // external assets, no licensing questions. Deliberately NOT favicons: hotlinking
  // each source's site would break the offline promise and leak which jurisdictions
  // are being assessed.
  const MONO_STOP = new Set(["the", "of", "and", "a", "an", "for", "on", "in", "&"]);
  // Leading jurisdiction tokens are redundant — the dashboard is already filtered to
  // one state, and the tag chip on the card says National/State.
  const MONO_JUR = /^(qld|queensland|nsw|vic|victoria|victorian|tas|tasmania|tasmanian|act|wa|nt|sa|south|western|northern|australian|australia)$/i;

  function monogramWords(name) {
    return String(name || "")
      .split("(")[0]                          // drop parentheticals: "… (ACHIS)"
      .replace(/[^A-Za-z0-9]+/g, " ")
      .trim().split(/\s+/)
      .filter((w) => w && !MONO_STOP.has(w.toLowerCase()));
  }

  // Case boundaries inside one word, used only when a name is a single word:
  // WetlandMaps -> Wetland Maps, LISTmap -> LIST map. Applying this up front would
  // wreck names where the spaced words are the distinguishing ones ("WildNet species
  // search" wants WS, not WN).
  function monogramSplitCase(word) {
    return word
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]{2,})([a-z])/g, "$1 $2")
      .split(/\s+/).filter(Boolean);
  }

  function iconMonogram(src) {
    let words = monogramWords(src.name);
    // Strip leading jurisdiction tokens, but never strip the name away entirely.
    let i = 0;
    while (i < words.length - 1 && MONO_JUR.test(words[i])) i++;
    if (i < words.length) words = words.slice(i);
    if (words.length === 1) words = monogramSplitCase(words[0]);
    if (!words.length) return "??";
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    const w = words[0];
    return (w.length >= 2 ? w.slice(0, 2) : w).toUpperCase();
  }

  function renderSourceIcon(src) {
    return el("span", {
      class: `src-icon jur-${src.jurisdiction === "national" ? "national" : "state"}`,
      "aria-hidden": "true",      // the card name is right beside it — don't double-announce
    }, iconMonogram(src));
  }

  // ---------------------------------------------------------------- images
  // Station/evidence photos are downscaled client-side (canvas) before being kept
  // as JPEG data URLs — keeps localStorage + exported JSON/HTML a sane size while
  // staying fully self-contained (no server, no separate image files).
  const MAX_IMG_DIM = 1600, IMG_QUALITY = 0.82;
  let imgSeq = 0;
  const newImgId = () => `img${Date.now()}_${imgSeq++}`;

  // The captured Queensland Globe map is not an evidence thumbnail — it is THE
  // map of the site, and the report renders it full width and clickable rather
  // than as a 90px crop among the photos. In live state that is carried by the
  // image id (openQldGlobeMap mints "qldmap-…"); `kind` carries it through an
  // export so a re-imported findings file still renders it as the map.
  const QLD_MAP_KIND = "qld_globe_map";
  const isQldMapImage = (im) => !!im && (im.kind === QLD_MAP_KIND || String(im.id || "").startsWith("qldmap-"));

  function fileToResizedDataUrl(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type || !file.type.startsWith("image/")) { reject(new Error("not an image file")); return; }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("could not read file"));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("could not decode image"));
        img.onload = () => {
          let w = img.naturalWidth, h = img.naturalHeight;
          if (w > MAX_IMG_DIM || h > MAX_IMG_DIM) {
            const scale = MAX_IMG_DIM / Math.max(w, h);
            w = Math.round(w * scale); h = Math.round(h * scale);
          }
          const canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", IMG_QUALITY));
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  function filesFromClipboard(e) {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    const out = [];
    for (const item of items) if (item.kind === "file" && item.type && item.type.startsWith("image/")) { const f = item.getAsFile(); if (f) out.push(f); }
    return out;
  }

  // Wires a dropzone element for drag-drop / paste-while-focused / an explicit
  // "choose a file" button (zone.querySelector(".pick-btn"), if present), calling
  // onFiles(File[]) with whatever image files it collects. Shared by the
  // station-photo zone and each biosecurity source card's evidence-photo zone.
  // Deliberately does NOT open the file picker on a plain click on the zone body:
  // that would steal focus to the native OS dialog, so a click-then-paste gesture
  // (the zone's own instructions) would never reach the paste listener below.
  function wireDropzone(zone, input, onFiles) {
    const pickBtn = zone.querySelector(".pick-btn");
    if (pickBtn) pickBtn.addEventListener("click", (e) => { e.stopPropagation(); input.click(); });
    // Only when the zone itself (not a bubbled event from the nested pick button,
    // which already activates on Enter/Space natively) is the keydown target.
    zone.addEventListener("keydown", (e) => { if (e.target === zone && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); input.click(); } });
    input.addEventListener("change", () => { if (input.files.length) onFiles(Array.from(input.files)); input.value = ""; });
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drag"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault(); zone.classList.remove("drag");
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((f) => f.type && f.type.startsWith("image/"));
      if (files.length) onFiles(files);
    });
    zone.addEventListener("paste", (e) => {
      const files = filesFromClipboard(e);
      if (files.length) { e.preventDefault(); onFiles(files); }
    });
  }

  async function addImagesTo(list, files) {
    for (const file of files) {
      try {
        const dataUrl = await fileToResizedDataUrl(file);
        list.push({ id: newImgId(), dataUrl, caption: "", ts: Date.now() });
      } catch (err) { toast(`Skipped ${file.name || "file"}: ${err.message}`); }
    }
  }

  async function addSiteImages(files) {
    // fileToResizedDataUrl() is async (FileReader + canvas); if the user switches
    // to a different site before it resolves, loadSite() has already reassigned
    // state.siteImages to a fresh array — pushing into the (now orphaned) array we
    // captured here would silently lose the photo with no render/save to show it.
    const site = state.site;
    await addImagesTo(state.siteImages, files);
    if (state.site !== site) { toast("Site changed before the photo finished processing — discarded"); return; }
    saveImages(); renderSiteImages(); renderReport(); refreshFocusForPhotos();
  }
  function removeSiteImage(id) {
    state.siteImages = state.siteImages.filter((im) => im.id !== id);
    saveImages(); renderSiteImages(); renderReport(); refreshFocusForPhotos();
  }
  // The photos step's own state (and the report front page it feeds) both move
  // when a picture is added or dropped, and neither renderSiteImages nor
  // renderReport reaches Focus mode. Declared, not arrow, so it is hoisted above
  // the image helpers that call it.
  function refreshFocusForPhotos() {
    if (focusLive()) renderFocus({ focus: false });
  }

  async function addFindingImages(sourceId, files) {
    const site = state.site;
    const f = state.findings[sourceId] || (state.findings[sourceId] = { status: STATUS.UNSET, note: "", result: null, images: [] });
    if (!f.images) f.images = [];
    await addImagesTo(f.images, files);
    if (state.site !== site) { toast("Site changed before the photo finished processing — discarded"); return; }
    saveImages(); refreshCard(sourceId); renderReport();
  }
  function removeFindingImage(sourceId, imgId) {
    const f = state.findings[sourceId];
    if (!f || !f.images) return;
    f.images = f.images.filter((im) => im.id !== imgId);
    saveImages(); refreshCard(sourceId); renderReport();
  }

  // ---------------------------------------------------------------- Wikipedia images
  // Auto-source a reference/identification photo for a named subject (a weed, a
  // feral animal, a pathogen) from Wikipedia — so a user doesn't have to go and
  // find one. The image is fetched, downscaled and embedded as a JPEG data URL
  // (same pipeline as uploaded photos), so it stays self-contained and travels
  // into the report + Print/HTML/JSON exports with its licensing attribution.
  //
  // This runs in the *user's* browser, which talks to Wikimedia directly:
  //  - the MediaWiki API returns anonymous CORS (`origin=*`) so fetchJson() works;
  //  - upload.wikimedia.org serves images with `Access-Control-Allow-Origin: *`,
  //    so a `crossOrigin=anonymous` <img> can be drawn to a canvas and read back
  //    with toDataURL() without tainting it.
  // Network/CORS failures are reported like any other source check, never fatal.
  const WM_API = "https://en.wikipedia.org/w/api.php";

  // Resolve a free-text term (usually a common name) to the best Wikipedia article
  // and its lead image via generator=search, so "Gamba grass" finds the right page
  // even though the article is titled "Andropogon gayanus".
  async function wmFindLeadImage(term) {
    const url = `${WM_API}?action=query&format=json&origin=*&redirects=1` +
      `&generator=search&gsrsearch=${encodeURIComponent(term)}&gsrlimit=1&gsrnamespace=0` +
      `&prop=pageimages%7Cinfo&piprop=original%7Cthumbnail&pithumbsize=1000&inprop=url`;
    const data = await fetchJson(url);
    const pages = data && data.query && data.query.pages;
    if (!pages) return null;
    const page = Object.values(pages)[0];
    if (!page) return null;
    const imageUrl = (page.original && page.original.source) || (page.thumbnail && page.thumbnail.source);
    if (!imageUrl) return null;
    return {
      title: page.title,
      pageUrl: safeHttpUrl(page.fullurl) || `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title)}`,
      imageUrl, fileTitle: page.pageimage ? `File:${page.pageimage}` : null,
    };
  }

  // Best-effort licensing attribution (artist + short licence name) for the lead
  // image, read from its file page's extmetadata. Wikimedia images are freely
  // licensed but require credit, so a government report should carry it.
  async function wmImageCredit(fileTitle) {
    if (!fileTitle) return "";
    try {
      const url = `${WM_API}?action=query&format=json&origin=*` +
        `&titles=${encodeURIComponent(fileTitle)}&prop=imageinfo&iiprop=extmetadata` +
        `&iiextmetadatafilter=Artist%7CLicenseShortName`;
      const data = await fetchJson(url);
      const pages = data && data.query && data.query.pages;
      const page = pages && Object.values(pages)[0];
      const meta = page && page.imageinfo && page.imageinfo[0] && page.imageinfo[0].extmetadata;
      if (!meta) return "";
      const strip = (m) => (m && m.value ? String(m.value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "");
      return [strip(meta.Artist), strip(meta.LicenseShortName)].filter(Boolean).join(" · ");
    } catch (_) { return ""; }
  }

  // Load a cross-origin image and re-encode it through a canvas to a self-contained
  // JPEG data URL, downscaled to the same bound as uploaded photos.
  function wmImageToDataUrl(imageUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous"; // required so toDataURL() isn't blocked by the taint check
      img.onerror = () => reject(new Error("could not load the image (network or cross-origin block)"));
      img.onload = () => {
        try {
          let w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h) { reject(new Error("image had no dimensions")); return; }
          if (w > MAX_IMG_DIM || h > MAX_IMG_DIM) {
            const scale = MAX_IMG_DIM / Math.max(w, h);
            w = Math.round(w * scale); h = Math.round(h * scale);
          }
          const canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", IMG_QUALITY));
        } catch (_) { reject(new Error("the image server did not allow cross-origin reuse")); }
      };
      img.src = imageUrl;
    });
  }

  // Full flow: search -> fetch -> attribute -> attach to the source card. Throws
  // on a hard failure (nothing found, image blocked) so the caller can toast it.
  async function addWikiImage(sourceId, term) {
    term = term.trim();
    if (!term) throw new Error("Type a name first");
    const site = state.site; // guard against a site switch mid-fetch (see addSiteImages)
    const found = await wmFindLeadImage(term);
    if (!found) throw new Error(`No Wikipedia image found for “${term}”`);
    const dataUrl = await wmImageToDataUrl(found.imageUrl);
    const credit = await wmImageCredit(found.fileTitle);
    if (state.site !== site) { toast("Site changed before the image loaded — discarded"); return; }
    const f = state.findings[sourceId] || (state.findings[sourceId] = { status: STATUS.UNSET, note: "", result: null, images: [] });
    if (!f.images) f.images = [];
    f.images.push({
      id: newImgId(), dataUrl, caption: found.title,
      credit: credit ? `Wikipedia · ${credit}` : "Source: Wikipedia",
      source_url: found.pageUrl, ts: Date.now(),
    });
    saveImages(); refreshCard(sourceId); renderReport();
    toast(`Added “${found.title}”`);
  }

  // -------------------------------------------------- subject extraction (auto)
  // The findings fields are free text, so pulling subjects out of them is
  // necessarily heuristic. We keep it HIGH-PRECISION so a wrong photo is never
  // attached to a government report, accepting only two unambiguous signals:
  //   (a) names from the curated reference lists (weeds, notable diseases), and
  //   (b) scientific binomials — "Genus species" (e.g. Phytophthora cinnamomi),
  //       incl. an optional infraspecific epithet (subsp./var./f.).
  // Generic Capitalised words are deliberately NOT harvested (place names,
  // headings, sentence starts produce too many false positives). Where the agent
  // supplies explicit `image_subjects`, those are used directly and this is only
  // the fallback. Callers pass the source category to scope the reference list.
  const DISEASE_TERMS = [
    "Myrtle rust", "Phytophthora dieback", "Phytophthora cinnamomi", "Austropuccinia psidii",
    "Chytrid fungus", "Panama disease", "Fire blight", "Ceratocystis", "Chalara", "Ceratocystis wilt",
  ];
  // "Genus species" with an optional "subsp./var./ssp./f. epithet" tail.
  const BINOMIAL_RE = /\b([A-Z][a-z]{2,})\s+([a-z]{3,})(?:\s+(?:subsp|var|ssp|f)\.?\s+([a-z]{3,}))?\b/g;
  // Reject a candidate whose leading word is a sentence-opener/status/qualifier
  // word, or whose second word is a generic report/admin noun — so "Local area",
  // "No records", "Status classes", "Recent surveys", "Delivery group" don't
  // become fake species, while real two-word names ("Feral pig", "Cane toad",
  // "Phytophthora cinnamomi") survive. Deliberately conservative toward rejection.
  const SUBJECT_STOP_LEAD = new Set(("the this that these those there a an and or but of in at on near far no not none nil " +
    "found known listed local locally site sites status record records report reports species specie state national " +
    "within around data note notes source sources result results search map maps tool tools protected threatened " +
    "vulnerable endangered critically declared restricted prohibited occurrence occurrences several multiple recent " +
    "numerous various many some all any two three no-known").split(" "));
  const SUBJECT_STOP_TAIL = new Set(("area areas site sites record records species specie status class classes conservation " +
    "tool tools search report reports map maps list lists data note notes result results level levels zone zones " +
    "matter matters place places within around near group groups officer officers survey surveys visit visits " +
    "inspection council park parks forest forests region regions team network authority department register " +
    "permit permits condition conditions summary section sections project projects program programs animal animals " +
    "plant plants pest pests weed weeds population populations community communities habitat habitats " +
    // common verbs/participles/adjectives that follow a noun in findings text, so
    // a real genus + English word ("Parthenium recorded") isn't read as a binomial
    "recorded observed found noted present absent detected confirmed seen reported identified mapped sighted " +
    "occurs occurring located situated known likely possible probable nearby adjacent common abundant widespread " +
    "established naturalised naturalized listed").split(" "));

  function extractSubjects(category, text) {
    if (!text || !WIKI_IMAGE_CATEGORIES.has(category)) return [];
    const out = [], seen = new Set();
    const add = (name) => { const k = name.toLowerCase(); if (name && !seen.has(k)) { seen.add(k); out.push(name); } };
    const lower = text.toLowerCase();

    // (a) curated reference-list names for the category
    const ref = category === "invasive_plants" ? DATA.weeds
      : category === "disease" ? DISEASE_TERMS : [];
    ref.forEach((name) => { if (name && lower.includes(name.toLowerCase())) add(name); });

    // (b) scientific binomials anywhere in the text
    let m; BINOMIAL_RE.lastIndex = 0;
    while ((m = BINOMIAL_RE.exec(text))) {
      if (SUBJECT_STOP_LEAD.has(m[1].toLowerCase()) || SUBJECT_STOP_TAIL.has(m[2].toLowerCase())) continue;
      add(m[3] ? `${m[1]} ${m[2]} ${m[3]}` : `${m[1]} ${m[2]}`);
    }
    return out.slice(0, MAX_AUTO_IMAGES_PER_CARD * 2); // a little headroom for dedupe/misses
  }

  // Auto-source reference photos for a list of subject names into a source card,
  // skipping any already attached (by term or resolved article title) and capping
  // the count. Best-effort per term (a miss/blocked image is swallowed). Renders
  // once at the end. Returns the number of images added.
  //
  // Serialised per source: the blur-triggered run and the button (or import + a
  // stray blur) can fire together, and each would otherwise snapshot the same
  // "already have" set and fetch every subject twice. A second concurrent call
  // for the same source is a no-op until the first finishes.
  const autoFetchInFlight = new Set();
  async function autoFetchImages(sourceId, terms, opts = {}) {
    terms = (terms || []).map((t) => String(t).trim()).filter(Boolean);
    if (!terms.length || autoFetchInFlight.has(sourceId)) return 0;
    autoFetchInFlight.add(sourceId);
    const site = state.site; // guard against a site switch mid-fetch (see addSiteImages)
    const f = state.findings[sourceId] || (state.findings[sourceId] = { status: STATUS.UNSET, note: "", result: null, images: [] });
    if (!f.images) f.images = [];
    const have = new Set(f.images.map((im) => (im.caption || "").toLowerCase()));
    const cap = opts.max || MAX_AUTO_IMAGES_PER_CARD;
    let added = 0;
    try {
      for (const term of terms) {
        if (added >= cap) break;
        if (have.has(term.toLowerCase())) continue;
        try {
          const found = await wmFindLeadImage(term);
          if (!found || have.has((found.title || "").toLowerCase())) continue;
          const dataUrl = await wmImageToDataUrl(found.imageUrl);
          const credit = await wmImageCredit(found.fileTitle);
          if (state.site !== site) return added; // superseded — drop silently
          f.images.push({
            id: newImgId(), dataUrl, caption: found.title,
            credit: credit ? `Wikipedia · ${credit}` : "Source: Wikipedia",
            source_url: found.pageUrl, ts: Date.now(), auto: true,
          });
          have.add((found.title || "").toLowerCase()); have.add(term.toLowerCase());
          added++;
        } catch (_) { /* best-effort per term */ }
      }
    } finally {
      autoFetchInFlight.delete(sourceId);
    }
    if (added && state.site === site) { saveImages(); refreshCard(sourceId); renderReport(); }
    return added;
  }

  // Task-2 path: scan THIS card's own note + result text for subjects and fetch a
  // reference photo for each new one. Triggered by the card's "Auto-fetch" button
  // and (when the global preference is on) when the note field loses focus.
  function findingText(f) {
    if (!f) return "";
    const resultText = f.result && f.result.html ? f.result.html.replace(/<[^>]+>/g, " ") : "";
    return [f.note || "", resultText].filter(Boolean).join(" ");
  }
  async function autoFetchFromNotes(sourceId, btn, quiet) {
    const src = DATA.sources.find((s) => s.id === sourceId);
    if (!src || !WIKI_IMAGE_CATEGORIES.has(src.category)) return;
    const terms = extractSubjects(src.category, findingText(state.findings[sourceId]));
    if (!terms.length) { if (!quiet) toast("No species/subject names detected in the notes yet."); return; }
    const orig = btn ? btn.innerHTML : "";
    if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spin"></span> Fetching…`; }
    try {
      const n = await autoFetchImages(sourceId, terms);
      // On a quiet (blur-triggered) run, only speak up when we actually added
      // something; the explicit button always reports the outcome.
      if (n) toast(`Added ${n} reference image${n > 1 ? "s" : ""}.`);
      else if (!quiet) toast("No new reference images found for the detected names.");
    } finally {
      if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = orig; }
    }
  }

  // Task-3 path: after a source is resolved by the API/agent (live BYOK run, the
  // ALA check, or an import), auto-source reference photos for a species card
  // that came back FOUND and has no evidence yet — using the agent's explicit
  // `image_subjects` when given, else subjects extracted from the finding text.
  // Never overwrites existing photos; silent + best-effort.
  function maybeAutoFetchForSource(id, imageSubjects) {
    if (!autoImagesOn()) return;
    const src = DATA.sources.find((s) => s.id === id);
    if (!src || !WIKI_IMAGE_CATEGORIES.has(src.category)) return;
    const f = state.findings[id];
    if (!f || f.status !== STATUS.FOUND || (f.images && f.images.length)) return;
    let terms = Array.isArray(imageSubjects) ? imageSubjects : [];
    if (!terms.length) terms = extractSubjects(src.category, findingText(f));
    if (terms.length) autoFetchImages(id, terms);
  }

  // Sweep an imported collection_log, kicking off an auto-fetch per species card
  // (honours each entry's optional `image_subjects`). Runs after the workspace is
  // rendered so cards fill in as their photos arrive.
  function autoFetchAfterImport(collectionLog) {
    if (!autoImagesOn()) return;
    (collectionLog || []).forEach((c) => {
      if (c && c.id) maybeAutoFetchForSource(c.id, Array.isArray(c.image_subjects) ? c.image_subjects : null);
    });
  }

  // Editable thumbnail (remove button + caption field) — used in the picker galleries.
  // Auto-sourced images (from Wikipedia) also carry a read-only `credit` line so
  // the licensing attribution stays attached to the photo everywhere it appears.
  // A photo you can open with the keyboard. These were bare <img onclick>: not in
  // the tab order at all, so the zoom/pan viewer and the Wikipedia source page
  // behind them were mouse-only, and what a click would do was said solely in a
  // `title` — invisible on touch, unreliable in a screen reader, and impossible to
  // reach by keyboard, which is the whole problem. A real button carries the
  // action, and the accessible name says which of the two things it does.
  function photoOpener(im, altFallback) {
    const alt = im.caption || altFallback || "";
    const source = !!im.source_url;
    return el("button", {
      type: "button", class: "photo-open",
      "aria-label": (alt ? `${alt} — ` : "") + (source ? "open the source page" : "view larger, with zoom and pan"),
      onclick: () => activateImage(im),
    }, el("img", {
      src: im.dataUrl, alt: alt || "Photo", loading: "lazy", decoding: "async",
    }));
  }

  function renderPhotoThumb(im, onRemove, onCaption) {
    // oninput saves as-you-type; onchange (fires on blur) refreshes the report
    // preview's figcaption — re-rendering on every keystroke would rebuild the
    // input out from under the user's cursor mid-edit.
    const cap = el("input", { type: "text", class: "photo-cap", placeholder: "Caption…",
      oninput: (e) => onCaption(e.target.value), onchange: () => renderReport() });
    cap.value = im.caption || "";
    return el("figure", { class: "photo-thumb" },
      photoOpener(im),
      el("button", { type: "button", class: "photo-remove", title: "Remove photo", onclick: onRemove }, "×"),
      cap,
      im.credit ? creditNode(im) : null);
  }
  // Report-preview thumbnail. onRemove (optional) adds a × to delete the photo
  // straight from the report; a Wikipedia photo opens its article, others zoom.
  function photoFigure(im, altFallback, onRemove) {
    const cap = im.caption || altFallback || "";
    return el("figure", { class: "photo-thumb view" },
      photoOpener(im, cap),
      onRemove ? el("button", { type: "button", class: "photo-remove", title: "Remove this photo from the report", onclick: onRemove }, "×") : null,
      (cap || im.credit) ? el("figcaption", {}, cap, im.credit ? creditNode(im) : null) : null);
  }
  // The captured Queensland Globe map, on screen. Full width of whatever it is
  // dropped into, height following the width, and a click opens the same
  // pan/zoom lightbox every other picture uses.
  function qldMapFigure(im, onRemove) {
    const cap = im.caption || "Queensland Globe — site map";
    return el("figure", { class: "report-globe" },
      el("img", { src: im.dataUrl, alt: cap, loading: "lazy", decoding: "async",
        title: "Open the full-screen map — scroll to zoom, drag to pan",
        onclick: () => openLightbox(im.dataUrl, cap) }),
      onRemove ? el("button", { type: "button", class: "photo-remove", title: "Remove this map from the report", onclick: onRemove }, "×") : null,
      el("figcaption", {}, cap, " — click to open full screen; the layer legend is in Appendix A."));
  }
  // Small attribution line ("Wikipedia · <artist> · <licence>"), linking to the
  // source page where one is recorded. Shared by the picker + report thumbnails.
  function creditNode(im) {
    const href = safeHttpUrl(im.source_url);
    return href
      ? el("a", { class: "photo-credit", href, target: "_blank", rel: "noopener", title: im.credit }, im.credit)
      : el("span", { class: "photo-credit", title: im.credit }, im.credit);
  }
  // Static HTML string version — used by the print view / HTML export / JSON export inputs.
  // `large` renders the bigger, uncropped layout used for the site photographs.
  // `interactive` allows the click-to-enlarge markup, which is meaningless on
  // paper — the print view passes false.
  // The Queensland Globe map is pulled OUT of the thumbnail grid and rendered
  // full width by qldMapFigureHtml: at 150px it was a coloured smudge nobody
  // could read the site off.
  function photosHtml(images, large, interactive) {
    if (!images || !images.length) return "";
    const maps = images.filter(isQldMapImage);
    const photos = images.filter((im) => !isQldMapImage(im));
    // esc() the data URL too, not just the caption — this string is injected via
    // innerHTML (print view) / a raw <script> template (HTML export), so an
    // unescaped value could break out of the src="" attribute (stored XSS) if it
    // ever originated from an imported findings file rather than our own canvas.
    const grid = photos.length ? `<div class="pr-photos${large ? " pr-photos-large" : ""}">${photos.map((im) => {
      const credit = im.credit
        ? `<span class="credit">${im.source_url ? `<a href="${esc(im.source_url)}">${esc(im.credit)}</a>` : esc(im.credit)}</span>` : "";
      const cap = (im.caption || im.credit)
        ? `<figcaption>${esc(im.caption || "")}${credit}</figcaption>` : "";
      return `<figure><img src="${esc(im.data_url)}" alt="${esc(im.caption || "")}">${cap}</figure>`;
    }).join("")}</div>` : "";
    return maps.map((im) => qldMapFigureHtml(im, interactive)).join("") + grid;
  }

  /* The Queensland Globe map in an exported report. Two things it must do that a
     photo thumbnail does not:
       • fill the width of the section it sits in, with the height following the
         width (aspect-ratio), so the site is actually legible on the page;
       • open full screen on a click, the way it does in the workbench.
     The exported HTML is a single self-contained file with NO script, so the
     full-screen view is done with a `:target` overlay — an anchor to a hidden
     div that CSS reveals when it is the URL fragment. No JavaScript, works from
     a file:// copy, and degrades to a plain picture when printed. */
  let prMapSeq = 0;
  function qldMapFigureHtml(im, interactive) {
    const src = esc(im.data_url);
    const cap = esc(im.caption || "Queensland Globe — site map");
    const img = `<img class="pr-globe-img" src="${src}" alt="${cap}">`;
    if (!interactive)
      return `<figure class="pr-globe">${img}
        <figcaption class="pr-globe-cap">${cap} — layer legend in Appendix A.</figcaption></figure>`;
    const id = `pr-globe-full-${++prMapSeq}`;
    return `<figure class="pr-globe">
      <a class="pr-globe-link" href="#${id}" title="Open the full-screen map">${img}</a>
      <figcaption class="pr-globe-cap">${cap} — click the map to open it full screen; layer legend in Appendix A.</figcaption>
    </figure>
    <div class="pr-lightbox" id="${id}" role="dialog" aria-label="${cap}">
      <a class="pr-lightbox-bg" href="#" aria-label="Close the full-screen map"></a>
      <img class="pr-lightbox-img" src="${src}" alt="${cap}">
      <a class="pr-lightbox-x" href="#">✕ Close</a>
    </div>`;
  }

  // A data: URL is the only form these images should ever take (our own canvas
  // export, or a previously-exported findings file). Rejecting anything else at
  // the import boundary keeps a crafted findings JSON from smuggling in a URL
  // that could misbehave when later interpolated into exported HTML.
  const DATA_IMG_RE = /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i;
  // A photo's credit line can link back to its source page (Wikipedia). That link
  // becomes an <a href> in the live UI and in exported HTML, so only allow plain
  // http(s) — never javascript:/data: etc. — whether it came from our own fetch
  // or an imported (untrusted) findings file.
  const safeHttpUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : "");

  // Rehydrate images from an exported ess-findings/1 file ({caption, data_url,
  // credit, source_url}) back into the tool's internal shape, so export -> import
  // round-trips photos and their attribution too.
  function importImages(list) {
    if (!Array.isArray(list)) return [];
    return list.map((im) => ({
      id: newImgId(), dataUrl: (im && (im.data_url || im.dataUrl)) || "",
      caption: (im && im.caption) || "", credit: (im && im.credit) || "",
      // Only the one value is ever accepted — an imported file must not be able
      // to invent image kinds the renderer has never heard of.
      kind: (im && im.kind === QLD_MAP_KIND) ? QLD_MAP_KIND : "",
      source_url: safeHttpUrl(im && (im.source_url || im.sourceUrl)), ts: Date.now(),
    })).filter((im) => DATA_IMG_RE.test(im.dataUrl));
  }

  function renderSiteImages() {
    const grid = $("#site-photo-grid");
    if (!grid) return;
    grid.innerHTML = "";
    (state.siteImages || []).forEach((im) => grid.append(renderPhotoThumb(im, () => removeSiteImage(im.id), (v) => { im.caption = v; saveImages(); })));
    renderSiteHeader(); // the header carries the count, which just changed
  }

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

  // Optional reference list of named weeds — powers autocomplete suggestions on the
  // invasive-plant cards' "reference image" field. Best-effort: a missing file just
  // means no suggestions (the field still accepts free text). The build ships an
  // A–Z scaffold, so drop the single-letter section headers.
  async function loadReference() {
    try {
      const res = await fetch("data/reference/weeds.json", { cache: "no-cache" });
      if (!res.ok) return;
      const j = await res.json();
      DATA.weeds = (j.weeds || []).filter((w) => typeof w === "string" && w.trim().length > 1);
    } catch (_) { /* suggestions are optional */ }
  }

  // State boundary polygons, for resolving a manually-entered/imported coordinate
  // to its real state (see stateFromCoords). Best-effort: if this fails to load,
  // stateFromCoords just falls back to the coarser bounding-box heuristic.
  // Hand-authored standardized narrative templates (GBO text, koala district,
  // duty-of-care, impact boilerplate…) used to seed report-section detail. Durable
  // and separate from the build-generated dropdowns.json. Best-effort: a missing
  // file just means the "Insert suggested detail" helper falls back to evidence.
  async function loadStatements() {
    try {
      const res = await fetch("data/statements.json", { cache: "no-cache" });
      if (!res.ok) return;
      DATA.statements = (await res.json()) || {};
    } catch (_) { /* narrative templates are optional */ }
  }

  async function loadStateBoundaries() {
    try {
      const res = await fetch("data/reference/au_states.geojson", { cache: "no-cache" });
      if (!res.ok) return;
      const gj = await res.json();
      DATA.stateBoundaries = (gj.features || [])
        .map((f) => {
          const code = STATE_NAME_TO_CODE[f.properties && f.properties.name];
          if (!code) return null;
          const geom = f.geometry;
          const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
          return { code, polys };
        })
        .filter(Boolean);
    } catch (_) { /* falls back to the bounding-box heuristic */ }
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

  // Turn a DATA.stations entry into the internal site object. Shared by the
  // single-site picker and the batch builder so both resolve stations identically.
  function stationToSite(s) {
    return {
      name: s.name, station_num: s.station_num, wmo: s.wmo, state: s.state,
      region: s.region, delivery_group: s.delivery_group, facility_types: s.facility_types,
      primary_facility: s.primary_facility, lat: s.lat, lon: s.lon,
      operating_authority: s.operating_authority, ident: s.ident, refs: s.refs, manual: false,
    };
  }

  function selectStation(s) {
    $("#station-search").value = s.name;
    $("#station-results").hidden = true;
    loadSite(stationToSite(s));
  }

  // Split a pasted "lat, lon" pair into its two parts. Accepts any mix of
  // commas and/or whitespace as the separator (e.g. "-25.089111, 152.5489",
  // "-25.089111,152.5489" or "-25.089111  152.5489"). Returns null unless the
  // paste is exactly two numeric tokens, so single-value pastes fall through
  // to the browser's normal behaviour.
  function splitLatLonPaste(raw) {
    if (!raw) return null;
    const parts = String(raw).trim().split(/[\s,]+/).filter(Boolean);
    if (parts.length !== 2) return null;
    if (!isFinite(Number(parts[0])) || !isFinite(Number(parts[1]))) return null;
    return { lat: parts[0], lon: parts[1] };
  }

  // Build the internal site object for a manual coordinate entry. Shared by the
  // single-site coordinate loader and the batch builder's pasted `lat,lon` lines.
  function coordToSite(lat, lon, name, st) {
    st = st || stateFromCoords(lat, lon);
    return {
      name: (name && name.trim()) || `Site @ ${lat.toFixed(4)}, ${lon.toFixed(4)}`,
      station_num: "", wmo: "", state: st, region: st, delivery_group: "", facility_types: [],
      primary_facility: "", lat, lon, operating_authority: "", ident: "",
      refs: refsForState(st), manual: true,
    };
  }

  function loadCoordSite() {
    const lat = parseFloat($("#in-lat").value), lon = parseFloat($("#in-lon").value);
    if (isNaN(lat) || isNaN(lon)) { alert("Enter a valid latitude and longitude."); return; }
    const st = $("#in-state").value || stateFromCoords(lat, lon);
    loadSite(coordToSite(lat, lon, $("#in-name").value, st));
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

  // Point `state` at a site and pull its saved progress from localStorage, WITHOUT
  // rendering. Used both by loadSite (interactive) and, in the batch flow, to visit
  // each site's stored state in turn (e.g. to build a batch review) without touching
  // the DOM or kicking off per-site map/image work.
  function loadSiteState(site) {
    state.site = site;
    state.findings = {};
    state.report = {};
    state.siteImages = [];
    state.maps = freshMaps();
    state.qldMap = { selection: null, capture: null };
    state.date = new Date().toISOString().slice(0, 10);
    state.maintenance = "";
    state.filter = "all";  // restore() brings back this site's own filter choice
    state.groupOpen = {};  // …and its own collapse choices
    state.flow = freshFlow(); // …and how far it got through step 3
    resetFocusCursor();    // …and where Focus mode had got to (restore() brings this site's back)
    imagesDirty = false; // fresh state; restore() re-flags this if a legacy save needs migrating
    restore(); // pull any saved progress for this site
  }

  // `focus: false` for the one caller that isn't a person choosing a site —
  // restoreBatch() re-opens the last site at boot, and taking focus into the
  // workspace on page load is exactly the behaviour renderWorkspace()'s jump is
  // there to avoid.
  function loadSite(site, opts) {
    flushSave(); // persist any pending debounced edit for the previous site before switching
    loadSiteState(site);
    syncBatchActive(); // highlight the matching chip if this site belongs to the loaded batch
    renderWorkspace(opts);
  }

  // Step 1 folds away once a site is open (see renderWorkspace). It is shown again
  // by Change site — which clears the workspace — and by the nav rail's ① button,
  // which does not: switching site from there should not throw away what is on
  // screen until a different site is actually chosen.
  function setSitePickerOpen(open) {
    const picker = $("#site-picker");
    if (picker) picker.hidden = !open;
  }
  function showSitePicker() {
    setSitePickerOpen(true);
    jumpTo($("#site-picker"));
    $("#station-search").focus();
  }

  function renderWorkspace(opts) {
    $("#workspace").hidden = false;
    // The picker has done its job — the site header names the site and carries
    // Change site, so leaving a 230 px search card above the workspace is a third
    // screen of preamble on every visit. showSitePicker() brings it straight back.
    setSitePickerOpen(false);
    const wr = $("#workspace-right"); if (wr) wr.hidden = false;
    const ph = $("#report-placeholder"); if (ph) ph.hidden = true;
    measureTopbar();
    resetRunChecks(); // step 3 talks about one site at a time
    syncFlowSteps();  // …and points at this site's next un-run sub-step
    syncGuide();      // first visit gets the how-to; everyone else gets the ?
    setSiteDetailsOpen(siteDetailsOpen()); // step 2's panel, as this browser left it
    renderSummary();
    renderSiteImages();
    renderMapsSections();
    ensureAllMaps();
    renderDashboard(); // renders the collection bar on the way through
    renderReport();
    $("#fld-date").value = state.date;
    $("#fld-maintenance").value = state.maintenance;
    // Focus mode renders the same state as one step instead of two panes, and owns
    // its own "where should the operator be looking" — so it returns here rather
    // than falling through to the workbench's jump.
    if (focusLive()) {
      // A site that has just been chosen makes the picking step done; don't leave
      // the operator sitting on it.
      if (state.site && focusCursor === "site:pick") focusCursor = null;
      renderCollectionStatus(); // renderDashboard() skipped it, and the step list counts it
      renderFocus({ focus: !opts || opts.focus !== false });
      return;
    }
    // Choosing a site is a jump like any other, so focus follows it to the site
    // header — otherwise the operator picks a station and their next Tab restarts
    // from the top bar. The exception is the boot-time batch restore, which passes
    // focus:false: nobody asked for it, and it must not take focus off a page that
    // has only just loaded.
    jumpTo($("#site-summary") || $("#workspace"), { focus: !opts || opts.focus !== false });
  }

  function isFindingsObject(json) {
    return json && typeof json === "object" && json.site && Array.isArray(json.collection_log);
  }

  // Build `state` from one ess-findings/1 object, WITHOUT rendering, saving, or
  // fetching images. The reusable core of importFindings — the batch importer calls
  // it once per site to populate + persist each without a full workspace render.
  function applyFindings(json) {
    const si = json.site;
    // Remember what's already on screen: if this file is for the site currently
    // open, results it doesn't carry are kept rather than wiped (see mergePrevious
    // below). The primary workflow runs the auto-checks BEFORE the assistant's
    // reply comes back, and an assistant that skips a source must not undo them.
    const prevSite = state.site;
    const prevFindings = state.findings || {};
    const prevFlow = state.flow;
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
    state.siteImages = importImages(si.images);
    // Rehydrate a carried-through map if the file has one; otherwise leave it to
    // auto-generate for the imported coordinates.
    // Rehydrate carried-through maps. New exports carry `site.maps` (one object per
    // slot); older single-map files carry `site.map`, which seeds the local slot.
    state.maps = freshMaps();
    const impSlots = (si.maps && typeof si.maps === "object") ? si.maps : (si.map ? { local: si.map } : {});
    for (const [key, mm] of Object.entries(impSlots)) {
      const ms = mapState(key);
      if (!mm) continue;
      const url = mm.data_url || mm.dataUrl;
      ms.km = (+mm.km) || ms.km;
      ms.labels = mm.labels !== false; // default on unless the file says otherwise
      ms.image = (url && DATA_IMG_RE.test(url))
        ? { dataUrl: url, km: (+mm.km) || ms.km, zoom: mm.zoom || 0, labels: ms.labels, lat, lon, ts: Date.now() }
        : null;
      ms.status = ms.image ? "ready" : "idle";
      ms.error = "";
    }
    state.findings = {};
    json.collection_log.forEach((c) => {
      if (!c || !c.id) return;
      state.findings[c.id] = {
        status: c.status || STATUS.UNSET, note: c.note || "", reviewed: !!c.reviewed,
        result: c.result_text ? { html: esc(c.result_text).replace(/\n/g, "<br>"), ts: Date.now() } : null,
        images: importImages(c.images),
      };
    });
    const sameSite = isSameSite(prevSite, state.site);
    if (sameSite) mergePrevious(prevFindings);
    // Step 3's progress belongs to the site, not the file: a reply for the site
    // already open confirms the round trip the operator just made, while a file
    // for a different site starts that sequence again.
    state.flow = sameSite ? normalizeFlow(prevFlow) : freshFlow();
    // …and so does Focus mode's place in the flow: a reply for the site already open
    // leaves the operator where they were (their step list simply gains a lot of
    // answered steps); a file for a different site starts that walk again.
    if (!sameSite) resetFocusCursor();
    state.report = {};
    (json.sections || []).forEach((s) => { if (s && s.id) state.report[s.id] = { choice: s.choice || null, note: s.note || "", reviewed: !!s.reviewed }; });
    // …and the front page's own tick, which rides in the site block (see reportObject).
    state.report[IDENTITY_SECTION] = { choice: null, note: "", reviewed: !!si.front_page_reviewed };
    // Seed jurisdiction-specific section defaults (e.g. the QLD GBO text) where the
    // imported file left the section blank, so they still appear in the report.
    REPORT_SECTIONS.forEach((sec) => {
      const def = defaultSectionNote(sec.id);
      if (!def) return;
      const rs = state.report[sec.id] || (state.report[sec.id] = { choice: null, note: "" });
      if (!rs.note || !rs.note.trim()) rs.note = def;
    });
    // Rehydrate the Queensland Globe map appendix. It travels as its own object
    // so an imported report still lists the layers the map was drawn from, even
    // when the picture itself didn't survive the round trip.
    const qg = json.qld_globe_map || (si && si.qld_globe_map);
    state.qldMap = { selection: null, capture: null };
    if (qg && typeof qg === "object") {
      const selection = Array.isArray(qg.selection) ? qg.selection
        : (Array.isArray(qg.layers) ? qg.layers.map((l) => l.id).filter(Boolean) : null);
      // Prefer the file's own layer descriptions. A file that recorded only the
      // ticked ids (hand-written, or an older export) still gets a real appendix
      // by resolving those ids against the map module's catalogue.
      let layers = Array.isArray(qg.layers) && qg.layers.length ? qg.layers.map(normalizeQldLayer) : null;
      if (!layers && selection && selection.length && window.ESSQldMap)
        layers = window.ESSQldMap.describe(selection).map(normalizeQldLayer);
      state.qldMap = {
        selection,
        capture: (layers && layers.length)
          ? { at: qg.captured_at ? Date.parse(qg.captured_at) || Date.now() : Date.now(), caption: qg.caption || "",
            lat: qg.lat, lon: qg.lon, scale: qg.scale, pin_in_view: qg.pin_in_view !== false, layers }
          : null,
      };
    }
    state.date = si.assessment_date || new Date().toISOString().slice(0, 10);
    state.maintenance = si.site_maintenance || "";
    state.groupOpen = {}; // an incoming run answers the categories itself; fold by state
    focusOnOutstanding();
  }

  // What the attention banner used to be for. An import (or an agent run) answers
  // most of the list and leaves the rest to a human, so the control lands on that
  // subset itself rather than announcing it in a second voice and asking for a
  // click — the pressed segment says why the list is short, and "All" is one click
  // away. A run that left nothing outstanding stays on the whole list: filtering to
  // an empty "Needs you" would be a worse answer than showing the finished work.
  function focusOnOutstanding() {
    state.filter = sourcesForSite().some((s) => isOutstanding(state.findings[s.id] || {})) ? "attention" : "all";
  }

  // Is an imported findings file describing the site that's already open? siteKey
  // equality is too brittle here — an assistant re-typing the site block can round
  // the coordinates it echoes back — so match on the station number where there is
  // one, and otherwise on a coordinate landing within ~100 m.
  function isSameSite(a, b) {
    if (!a || !b) return false;
    if (a.station_num || b.station_num) return !!a.station_num && String(a.station_num) === String(b.station_num);
    return Math.abs(a.lat - b.lat) < 0.001 && Math.abs(a.lon - b.lon) < 0.001;
  }

  // Does an imported collection_log entry actually say anything?
  function entryHasContent(f) {
    return !!(f && ((f.status && f.status !== STATUS.UNSET) || (f.note || "").trim() || f.result || (f.images || []).length));
  }

  // Fold the findings that were already on screen into the ones just imported, for
  // a file describing the site that is already open. Two rules:
  //   · an imported entry that says nothing leaves the existing result untouched
  //     (this is what stops a pasted reply wiping the auto-checks, or a note the
  //     operator typed before pasting);
  //   · an imported entry that does say something wins on the finding itself, but
  //     the operator's own bookkeeping — the review tick, which report section the
  //     card feeds, whether it's included — carries over, since a findings file
  //     doesn't carry any of it.
  function mergePrevious(prevFindings) {
    for (const [id, prev] of Object.entries(prevFindings || {})) {
      const next = state.findings[id];
      if (!entryHasContent(next)) {
        if (entryHasContent(prev)) state.findings[id] = prev;
        continue;
      }
      if (prev.reviewed && !next.reviewed) next.reviewed = true;
      if (prev.targetSection && next.targetSection == null) next.targetSection = prev.targetSection;
      if (typeof prev.included === "boolean" && typeof next.included !== "boolean") next.included = prev.included;
      // Photos the operator added to the card aren't in the file — keep them.
      if (!(next.images || []).length && (prev.images || []).length) next.images = prev.images;
    }
  }

  // One appendix layer row out of an untrusted findings file, trimmed to the
  // fields the report actually renders — and with its legend swatches validated
  // as data: images, since they end up in an <img src> in exported HTML.
  function normalizeQldLayer(l) {
    const legend = safeLegend(l && l.legend);
    return {
      id: String((l && l.id) || ""), name: String((l && l.name) || ""), group: String((l && l.group) || ""),
      service: String((l && l.service) || ""), url: safeHttpUrl(l && l.url),
      sublayer: (l && l.sublayer) != null ? l.sublayer : null,
      legend, legend_more: Math.max(0, +((l && l.legend_more) || 0)),
    };
  }

  // Load a completed (or partial) ess-findings/1 object — from the agent skill
  // or a prior export — and populate the same review/export surface.
  function importFindings(json) {
    if (!isFindingsObject(json))
      throw new Error("Not an ESS findings file — expected a `site` object and a `collection_log` array.");
    flushSave(); // persist any pending debounced edit for the previously loaded site first
    clearBatch(false); // a single import stands alone — drop any loaded batch (keeps each site's saved work)
    applyFindings(json);
    renderWorkspace();
    imagesDirty = true; // imported photos + map must be written to the image key
    save();
    autoFetchAfterImport(json.collection_log); // async, best-effort (Task 3)
  }

  // Import an ess-findings-batch/1 object: { sites: [ <ess-findings/1>, … ] }.
  // Each site is populated + persisted under its own per-site key (no render), then
  // the batch tray is shown and the first site is opened in the workspace.
  function importBatch(batch) {
    const all = Array.isArray(batch && batch.sites) ? batch.sites : [];
    const sites = all.filter(isFindingsObject);
    if (!sites.length) throw new Error("Not an ESS batch file — expected a `sites` array of findings objects.");
    flushSave(); // persist any pending edit for the previously loaded site first
    const keys = [];
    let firstSite = null;
    sites.forEach((sj) => {
      try {
        applyFindings(sj);           // build state for this site
        const key = siteKey(state.site);
        if (keys.includes(key)) return; // de-dupe within the batch
        imagesDirty = true;
        saveNow();                   // persist synchronously under this site's key (state-sourced)
        keys.push(key);
        if (!firstSite) firstSite = state.site;
      } catch (_) { /* skip an unparseable site rather than fail the whole batch */ }
    });
    if (!keys.length) throw new Error("None of the sites in the batch could be loaded.");
    state.batch = { generated: batch.generated || new Date().toISOString(), keys, active: keys[0] };
    persistBatch();
    loadSite(firstSite);             // open the first site (restore + render); highlights its chip
    renderBatchBar();
    offerBatchHandoff(keys.length);  // …and, in Focus, says where the other sites are
    toast(`Imported ${keys.length} site${keys.length > 1 ? "s" : ""} — pick one below to review`);
  }

  // Create a batch straight from a list of resolved site objects (the in-browser
  // batch builder). Each site gets a blank per-site state — or its existing saved
  // work, if it was assessed before — persisted under its own key, then the batch
  // tray is shown and the first site opens. Same end state as importBatch, minus
  // the file: the user then works each site with the normal collect tools.
  function createBatchFromSites(sites) {
    const list = (sites || []).filter((s) => s && isFinite(s.lat) && isFinite(s.lon));
    if (!list.length) { toast("Pick at least one site first"); return; }
    flushSave(); // persist any pending edit for the previously loaded site first
    const keys = [];
    let firstSite = null;
    list.forEach((site) => {
      const key = siteKey(site);
      if (keys.includes(key)) return;   // de-dupe within the batch
      loadSiteState(site);              // blank state (or restores this site's saved work)
      saveNow();                        // persist the per-site payload so its chip renders + resumes
      keys.push(key);
      if (!firstSite) firstSite = site;
    });
    if (!keys.length) { toast("No valid sites to batch"); return; }
    state.batch = { generated: new Date().toISOString(), keys, active: keys[0] };
    persistBatch();
    loadSite(firstSite);               // open the first site (restore + render); highlights its chip
    renderBatchBar();
    offerBatchHandoff(keys.length);    // …and, in Focus, says where the other sites are
    toast(`Batch of ${keys.length} site${keys.length > 1 ? "s" : ""} ready — pick one below to start`);
  }

  // ---------------------------------------------------------------- summary
  // The station record as the operator reads it back — one list, one order, used by
  // the workbench's metadata grid AND by Focus mode's site-details step, so the two
  // can never describe the same station differently.
  function stationRecordRows() {
    const s = state.site || {};
    return [
      ["Station Name", s.name],
      ["Station Number", s.station_num || "—"],
      ["WMO Number", s.wmo || "—"],
      ["State", s.state || "—"],
      ["Delivery Group", s.delivery_group || "—"],
      ["Facility", (s.facility_types && s.facility_types.join(", ")) || s.primary_facility || "—"],
      ["Latitude", s.lat],
      ["Longitude", s.lon],
    ];
  }

  function renderSummary() {
    const s = state.site;
    const rows = stationRecordRows();
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
    syncSiteCorrectFields();
    renderSiteHeader();
  }

  // ------------------------------------------------- correcting the station record
  // Which #sd-correct field writes which property. Deliberately none of the three
  // that identify the site: station_num keys its saved work (siteKey), and lat/lon
  // are what every deep link, map and API query is built from — a wrong one of
  // those is a different site, not a typo, and Change site is the route to it.
  const SITE_CORRECT_FIELDS = [
    { sel: "#fld-site-name", get: (s) => s.name || "", set: (s, v) => { s.name = v.trim() || s.name; } },
    { sel: "#fld-site-wmo", get: (s) => s.wmo || "", set: (s, v) => { s.wmo = v.trim(); } },
    { sel: "#fld-site-group", get: (s) => s.delivery_group || "", set: (s, v) => { s.delivery_group = v.trim(); } },
    { sel: "#fld-site-facility",
      get: (s) => (s.facility_types && s.facility_types.join(", ")) || s.primary_facility || "",
      set: (s, v) => {
        const list = v.split(";").map((x) => x.trim()).filter(Boolean);
        s.facility_types = list;
        s.primary_facility = list[0] || "";
      } },
  ];

  // Push `state.site` into the correction inputs — on load, and after anything else
  // changes the record — so an open disclosure never shows a stale value.
  function syncSiteCorrectFields() {
    const s = state.site;
    if (!s) return;
    SITE_CORRECT_FIELDS.forEach(({ sel, get }) => {
      const inp = $(sel);
      if (inp && document.activeElement !== inp) inp.value = get(s);
    });
    const st = $("#fld-site-state");
    if (st && document.activeElement !== st) st.value = s.state || "";
  }

  // A corrected descriptive field is a re-render of everything that quotes it (the
  // header, the summary, the report's front page) and nothing more.
  function correctSiteField(field, value) {
    if (!state.site) return;
    field.set(state.site, value);
    save();
    renderSummary(); renderSiteHeader(); renderReportHeader(); renderReport();
    if (focusLive()) renderFocus({ focus: false });
  }

  // …with one exception. The state decides which sources apply at all, so changing
  // it is a different assessment list — a full workspace render, which in Focus mode
  // recomputes the step graph off the new list.
  function correctSiteState(code) {
    const s = state.site;
    if (!s || code === s.state) return;
    s.state = code || stateFromCoords(s.lat, s.lon);
    s.region = s.state;
    s.refs = refsForState(s.state);
    save();
    renderWorkspace({ focus: false });
    toast(s.state ? `Sources now shown for ${s.state}` : "State cleared");
  }

  // The resting state of step 2 — who the site is, where it is, what the locator
  // maps look like and how many photos it has. Everything it names is editable in
  // the panel underneath; this is the header the operator confirms at a glance.
  // Cheap enough to rebuild whole, so anything it reports (photos, maps, the date)
  // just calls it again.
  function renderSiteHeader() {
    const s = state.site;
    if (!s || !$("#sd-name")) return;
    $("#sd-name").textContent = s.name;
    const ids = [s.station_num && `#${s.station_num}`, s.state, s.delivery_group,
      (s.facility_types && s.facility_types.join(", ")) || s.primary_facility].filter(Boolean);
    $("#sd-ids").textContent = ids.join(" · ");

    const coords = `${s.lat}, ${s.lon}`;
    const coordBtn = $("#sd-coords");
    coordBtn.innerHTML = "";
    coordBtn.append(coords, el("span", { class: "sd-copy", "aria-hidden": "true" }, "⧉"));
    coordBtn.setAttribute("aria-label", `Copy the coordinates ${coords}`);

    // One thumbnail per locator map that has rendered; each opens the same
    // lightbox as the full-size figure in the panel.
    const thumbs = $("#sd-thumbs");
    thumbs.innerHTML = "";
    MAP_SLOTS.forEach((slot) => {
      const ms = mapState(slot.key);
      const m = ms.image;
      if (!m) return;
      const label = `${slot.title} — ${(+m.km).toLocaleString()} km across`;
      thumbs.append(el("button", {
        type: "button", class: "sd-thumb", title: `${label} — open the full map`, "aria-label": label,
        onclick: () => openLightbox(m.dataUrl, `${slot.title} — ${(+m.km).toLocaleString()} km across · ${s.name}`),
      }, el("img", { src: m.dataUrl, alt: "" })));
    });

    $("#sd-assessed").textContent = state.date ? `Assessed ${formatDate(state.date)}` : "";
    const n = (state.siteImages || []).length;
    const photos = $("#sd-photo-count");
    photos.textContent = n ? `${n} photo${n > 1 ? "s" : ""}` : "Add photos";
    photos.classList.toggle("is-empty", !n);
  }

  // dd Mon yyyy from the ISO date the date field stores, without pulling in a
  // locale-dependent format the report doesn't use.
  function formatDate(iso) {
    const d = new Date(`${iso}T00:00:00`);
    if (isNaN(d)) return iso;
    return `${d.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]} ${d.getFullYear()}`;
  }

  // Step 2's panel: the full station record, the map tuning controls, the editable
  // fields and the photo dropzone. Closed by default, remembered per browser.
  function siteDetailsOpen() { try { return localStorage.getItem(LS_SITE_DETAILS) === "1"; } catch (_) { return false; } }
  function setSiteDetailsOpen(open, focusSel) {
    const panel = $("#site-details"), btn = $("#btn-site-details");
    if (!panel || !btn) return;
    panel.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.textContent = open ? "Details ▴" : "Details ▾";
    try { localStorage.setItem(LS_SITE_DETAILS, open ? "1" : "0"); } catch (_) {}
    if (open && focusSel) {
      const target = $(focusSel);
      if (target) { target.scrollIntoView({ block: "nearest" }); target.focus(); }
    }
  }

  // ---------------------------------------------------------------- site map
  // Web-Mercator / slippy-tile helpers.
  function lonToWorldX(lon, worldPx) { return (lon + 180) / 360 * worldPx; }
  function latToWorldY(lat, worldPx) {
    const s = Math.sin(lat * Math.PI / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldPx;
  }
  // Nearest integer zoom whose native resolution best fits `km` across MAP_PX px
  // at this latitude. We fetch tiles at this zoom, then scale the stitch so the
  // output spans exactly the requested km (keeps the user's number honest).
  function pickZoom(lat, km) {
    const zf = Math.log2(MERCATOR_M_PER_PX0 * Math.cos(lat * Math.PI / 180) * MAP_PX / (km * 1000));
    return Math.max(MAP_MIN_ZOOM, Math.min(MAP_MAX_ZOOM, Math.round(zf)));
  }

  // Load one tile as a CORS-clean image (so the canvas stays exportable). Resolves
  // to the image, or null on error/timeout/out-of-range — a few missing tiles just
  // leave the neutral backdrop rather than failing the whole map. `urlFn` selects
  // the layer (imagery base, or a transparent reference overlay).
  function loadTile(z, x, y, n, urlFn = mapTileUrl) {
    return new Promise((resolve) => {
      if (y < 0 || y >= n) { resolve(null); return; }
      const xx = ((x % n) + n) % n; // wrap longitude at the date line
      const img = new Image();
      img.crossOrigin = "anonymous";
      let done = false;
      const finish = (val) => { if (done) return; done = true; clearTimeout(timer); resolve(val); };
      const timer = setTimeout(() => finish(null), MAP_TILE_TIMEOUT);
      img.onload = () => finish(img);
      img.onerror = () => finish(null);
      img.src = urlFn(z, xx, y);
    });
  }

  // Draw a classic teardrop map pin (white-outlined, red) centred so its tip sits
  // exactly on (x, y) — the station coordinates.
  function drawPin(ctx, x, y) {
    const r = 15, tipY = y, headY = y - 30;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
    ctx.beginPath();
    ctx.moveTo(x, tipY);
    ctx.bezierCurveTo(x - r * 0.9, y - 18, x - r, headY - r * 0.2, x - r, headY - r);
    ctx.arc(x, headY - r, r, Math.PI, 0, false);
    ctx.bezierCurveTo(x + r, headY - r * 0.2, x + r * 0.9, y - 18, x, tipY);
    ctx.closePath();
    ctx.fillStyle = "#e23b2e"; ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.lineWidth = 2.5; ctx.strokeStyle = "#ffffff"; ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, headY - r, 5.5, 0, 2 * Math.PI);
    ctx.fillStyle = "#ffffff"; ctx.fill();
    ctx.restore();
  }

  // Bottom-right imagery attribution + a bottom-left scale label, baked into the
  // image so they survive every export. When the road/place overlays are on,
  // their credit is appended.
  function drawMapOverlay(ctx, w, h, km, labels) {
    ctx.save();
    ctx.font = "600 12px -apple-system, Segoe UI, Roboto, Arial, sans-serif";
    const pad = 6, th = 18;
    const attrib = MAP_ATTRIB + (labels ? " · " + MAP_REF_ATTRIB : "");
    const aw = ctx.measureText(attrib).width + pad * 2;
    ctx.fillStyle = "rgba(0,0,0,.55)";
    ctx.fillRect(w - aw, h - th, aw, th);
    ctx.fillStyle = "#fff"; ctx.textBaseline = "middle";
    ctx.fillText(attrib, w - aw + pad, h - th / 2 + 1);
    const label = `${(+km).toLocaleString()} km across`;
    const lw = ctx.measureText(label).width + pad * 2;
    ctx.fillStyle = "rgba(0,0,0,.55)";
    ctx.fillRect(0, h - th, lw, th);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, pad, h - th / 2 + 1);
    ctx.restore();
  }

  // Fetch + stitch the satellite tiles for (lat, lon) spanning `km`, returning a
  // self-contained JPEG data URL. With `labels`, transparent Esri road + place
  // overlays are composited on top of the imagery (same host → still exportable).
  // Throws if no imagery tiles load or the canvas can't be exported (tainted — a
  // CORS regression at the tile host).
  async function buildMapDataUrl(lat, lon, km, labels) {
    const z = pickZoom(lat, km);
    const n = Math.pow(2, z);
    const worldPx = 256 * n;
    const res = MERCATOR_M_PER_PX0 * Math.cos(lat * Math.PI / 180) / n; // metres per source px
    const srcPx = (km * 1000) / res;         // source-pixel window == exactly `km`
    const scale = MAP_PX / srcPx;            // scale that window up/down to fill the output
    const cx = lonToWorldX(lon, worldPx), cy = latToWorldY(lat, worldPx);
    const left = cx - srcPx / 2, top = cy - srcPx / 2;
    const txMin = Math.floor(left / 256), txMax = Math.floor((left + srcPx) / 256);
    const tyMin = Math.floor(top / 256), tyMax = Math.floor((top + srcPx) / 256);

    // Layer 0 is the imagery base; any further layers are transparent overlays
    // drawn on top in order. Tiles are keyed by layer so the composite is stacked
    // correctly regardless of network completion order.
    const layers = [mapTileUrl].concat(labels ? MAP_REF_LAYERS : []);
    const jobs = [];
    for (let li = 0; li < layers.length; li++)
      for (let tx = txMin; tx <= txMax; tx++)
        for (let ty = tyMin; ty <= tyMax; ty++)
          jobs.push(loadTile(z, tx, ty, n, layers[li]).then((img) => ({ img, tx, ty, li })));
    const tiles = await Promise.all(jobs);
    if (!tiles.some((t) => t.li === 0 && t.img)) throw new Error("no satellite tiles could be loaded");

    const canvas = document.createElement("canvas");
    canvas.width = MAP_PX; canvas.height = MAP_PX;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#243039"; ctx.fillRect(0, 0, MAP_PX, MAP_PX); // backdrop for any missing tile
    const d = 256 * scale;
    for (let li = 0; li < layers.length; li++)
      for (const t of tiles) if (t.li === li && t.img)
        ctx.drawImage(t.img, Math.round((t.tx * 256 - left) * scale), Math.round((t.ty * 256 - top) * scale), Math.ceil(d), Math.ceil(d));
    drawPin(ctx, MAP_PX / 2, MAP_PX / 2);
    drawMapOverlay(ctx, MAP_PX, MAP_PX, km, labels);
    let dataUrl;
    try { dataUrl = canvas.toDataURL("image/jpeg", 0.85); }
    catch (err) { throw new Error("map could not be exported (imagery blocked cross-origin export)"); }
    return { dataUrl, km, zoom: z, labels: !!labels, lat, lon, ts: Date.now() };
  }

  // Per-slot accessor + DOM lookups. Each slot's controls + figure live inside
  // the dynamically-built section tagged with data-slot in #site-maps.
  const mapState = (slot) => state.maps[slot] || (state.maps[slot] = { km: (MAP_SLOT_BY_KEY[slot] || {}).defaultKm || MAP_DEFAULT_KM, labels: true, image: null, status: "idle", error: "" });
  const mapSectionEl = (slot) => document.querySelector(`#site-maps [data-slot="${slot}"]`);

  // Build the two map sections (controls + figure) into #site-maps. Rebuilt whenever
  // the workspace renders; renderSiteMap()/renderMapPresets() then fill each figure.
  function renderMapsSections() {
    const wrap = $("#site-maps");
    if (!wrap) return;
    wrap.innerHTML = "";
    MAP_SLOTS.forEach((slot) => {
      const ms = mapState(slot.key);
      const presets = el("span", { class: "map-presets" });
      const kmInput = el("input", { type: "number", min: MAP_MIN_KM, max: MAP_MAX_KM, step: 5, value: ms.km, inputmode: "numeric",
        onchange: (e) => setMapKm(slot.key, parseInt(e.target.value, 10)) });
      const labelsCb = el("input", { type: "checkbox", onchange: (e) => setMapLabels(slot.key, e.target.checked) });
      labelsCb.checked = ms.labels;
      const section = el("section", { class: "site-map-section", "data-slot": slot.key },
        el("div", { class: "map-head" },
          el("label", { class: "field-label" }, slot.title, " ", el("span", { class: "opt" }, `(satellite · ${slot.note} — carried through to the report & export)`)),
          el("div", { class: "map-controls" },
            presets,
            el("label", { class: "map-km-field" }, "Side ", kmInput, el("span", {}, "km")),
            el("label", { class: "map-toggle", title: "Overlay roads and locality/place labels on the satellite imagery" }, labelsCb, " Roads & labels"),
            el("button", { type: "button", class: "btn tiny", title: "Reload the satellite map for this location", onclick: () => generateSiteMap(slot.key) }, "↻ Refresh"))),
        el("figure", { class: "site-map" }));
      wrap.append(section);
      renderMapPresets(slot.key);
      renderSiteMap(slot.key);
    });
  }

  // Kick off (or re-use) both locator maps for the current site. Regenerates a
  // slot when its stored map is missing or was built for a different location/size.
  function ensureAllMaps(force) {
    MAP_SLOTS.forEach((slot) => ensureSiteMap(slot.key, force));
  }
  function ensureSiteMap(slot, force) {
    const s = state.site;
    if (!s) return;
    const ms = mapState(slot);
    const m = ms.image;
    const fresh = m && m.lat === s.lat && m.lon === s.lon && m.km === ms.km && m.labels === ms.labels;
    if (fresh && !force) { ms.status = "ready"; renderSiteMap(slot); return; }
    generateSiteMap(slot);
  }

  async function generateSiteMap(slot) {
    const s = state.site;
    if (!s) return;
    const ms = mapState(slot);
    const site = s, km = ms.km, labels = ms.labels, token = (mapGenTokens[slot] = (mapGenTokens[slot] || 0) + 1);
    ms.status = "loading"; ms.error = "";
    renderSiteMap(slot);
    try {
      const map = await buildMapDataUrl(s.lat, s.lon, km, labels);
      if (token !== mapGenTokens[slot] || state.site !== site) return; // superseded (site/size changed)
      ms.image = map; ms.status = "ready"; ms.error = "";
      saveImages(); renderSiteMap(slot); renderReport(); refreshFocusForMaps();
    } catch (err) {
      if (token !== mapGenTokens[slot] || state.site !== site) return;
      ms.status = "error"; ms.error = err.message || "could not load the map";
      renderSiteMap(slot); refreshFocusForMaps();
    }
  }

  // A map ARRIVING (or failing) moves the maps step's own state and puts a picture
  // on the report's front page, so Focus mode's chrome is refreshed when the
  // stitching settles — not while it is in flight, which would only redraw a
  // spinner. renderSiteMap has already painted the figure itself by this point;
  // this is the step list and the "done" tick catching up with it.
  function refreshFocusForMaps() {
    if (focusLive()) renderFocus({ focus: false });
  }

  function setMapKm(slot, km) {
    km = Math.round(Math.max(MAP_MIN_KM, Math.min(MAP_MAX_KM, km || 0)));
    if (!km) return;
    const ms = mapState(slot);
    const sec = mapSectionEl(slot);
    const input = sec && sec.querySelector(".map-km-field input");
    if (input && +input.value !== km) input.value = km;
    if (km === ms.km && ms.status === "ready") { renderMapPresets(slot); return; }
    ms.km = km;
    save();
    renderMapPresets(slot);
    generateSiteMap(slot);
  }

  // Toggle the road/place overlay on one locator map and re-render it.
  function setMapLabels(slot, on) {
    on = !!on;
    const ms = mapState(slot);
    if (on === ms.labels) return;
    ms.labels = on;
    const sec = mapSectionEl(slot);
    const cb = sec && sec.querySelector(".map-toggle input");
    if (cb && cb.checked !== on) cb.checked = on;
    save();
    generateSiteMap(slot);
  }

  function renderMapPresets(slot) {
    const sec = mapSectionEl(slot);
    const wrap = sec && sec.querySelector(".map-presets");
    if (!wrap) return;
    const ms = mapState(slot);
    wrap.innerHTML = "";
    (MAP_SLOT_BY_KEY[slot].presets || []).forEach((km) => {
      wrap.append(el("button", {
        type: "button", class: "map-preset btn tiny" + (km === ms.km ? " on" : ""),
        "aria-pressed": km === ms.km ? "true" : "false",
        onclick: () => setMapKm(slot, km),
      }, `${km} km`));
    });
  }

  // Render one slot's map area for its current state (loading / ready / error).
  function renderSiteMap(slot) {
    const sec = mapSectionEl(slot);
    const fig = sec && sec.querySelector(".site-map");
    if (!fig) return;
    fig.innerHTML = "";
    const s = state.site;
    if (!s) return;
    const ms = mapState(slot);
    const frame = el("div", { class: "map-frame" });

    if (ms.status === "loading") {
      frame.classList.add("is-loading");
      frame.append(el("div", { class: "map-msg" }, el("span", { class: "spin" }), " Loading satellite imagery…"));
      fig.append(frame);
      return;
    }
    if (ms.status === "error" || !ms.image) {
      frame.classList.add("is-error");
      const gmaps = `https://www.google.com/maps/@${s.lat},${s.lon},12z/data=!3m1!1e3`;
      frame.append(el("div", { class: "map-msg" },
        el("p", {}, "🛰 ", ms.error ? `Map unavailable — ${ms.error}.` : "Map not generated yet."),
        el("p", { class: "map-sub" }, "Satellite tiles are fetched from Esri; this needs an internet connection."),
        el("div", { class: "map-msg-actions" },
          el("button", { type: "button", class: "btn tiny", onclick: () => generateSiteMap(slot) }, "↻ Retry"),
          el("a", { class: "btn tiny", href: gmaps, target: "_blank", rel: "noopener" }, "Open in Google Maps ↗"))));
      fig.append(frame);
      renderSiteHeader(); // a slot with no image has no thumbnail either
      return;
    }
    // ready — scale + attribution are baked into the image itself (so they survive
    // export); the caption below just confirms the size/centre for the operator.
    const m = ms.image;
    frame.append(el("img", {
      class: "map-img", src: m.dataUrl, alt: `Satellite map centred on ${s.name} (${m.km} km across)`,
      title: "Open the full-screen map — scroll to zoom, drag to pan",
      onclick: () => openLightbox(m.dataUrl, `Satellite locator — ${(+m.km).toLocaleString()} km across · ${s.name}`),
    }));
    fig.append(frame);
    fig.append(el("figcaption", { class: "map-cap" },
      `${MAP_SLOT_BY_KEY[slot].title} — ${(+m.km).toLocaleString()} km across · centred on ${s.lat}, ${s.lon}`));
    renderSiteHeader(); // …and the header's thumbnail of it
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

  // ------------------------------------------------- PMST Excel (.xlsx) import
  // The EPBC Protected Matters Search Tool can export its result as an .xlsx.
  // We read that workbook entirely in the browser — no library, no upload — and
  // render the Matters of National Environmental Significance down to a text
  // summary in the PMST card's notes (which then flows into the ESS report).
  // An .xlsx is a ZIP of XML parts; we walk the central directory, inflate each
  // part with the platform DecompressionStream, and read the cells with
  // DOMParser (so XML entities/namespaces are handled for us).

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== "function")
      throw new Error("This browser can't open .xlsx files (needs DecompressionStream). Try a current Chrome, Edge, Firefox or Safari.");
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Parse a ZIP's central directory into { name: {method, start, size} } so we
  // only inflate the parts we actually need.
  function zipIndex(buf) {
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= 0; i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) throw new Error("Not a valid .xlsx file (no ZIP end-of-directory record).");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const index = {};
    for (let n = 0; n < count && p + 46 <= u8.length; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csz = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
      // The local header repeats the name/extra with possibly different lengths.
      const lNameLen = dv.getUint16(lho + 26, true);
      const lExtraLen = dv.getUint16(lho + 28, true);
      const start = lho + 30 + lNameLen + lExtraLen;
      index[name] = { method, start, size: csz };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { dv, u8, index };
  }

  async function zipReadText(zip, name) {
    const e = zip.index[name];
    if (!e) return "";
    const comp = zip.u8.subarray(e.start, e.start + e.size);
    const bytes = e.method === 0 ? comp : await inflateRaw(comp);
    return new TextDecoder("utf-8").decode(bytes);
  }

  const XLSX_COL = (ref) => {
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!m) return 0;
    let c = 0;
    for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
    return c - 1;
  };

  function xlsxSharedStrings(xml) {
    if (!xml) return [];
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    return Array.from(doc.getElementsByTagName("si")).map((si) =>
      Array.from(si.getElementsByTagName("t")).map((t) => t.textContent).join(""));
  }

  function xlsxSheetRows(xml, shared) {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const rows = [];
    for (const rowEl of doc.getElementsByTagName("row")) {
      const cells = [];
      for (const c of rowEl.getElementsByTagName("c")) {
        const ref = c.getAttribute("r");
        const t = c.getAttribute("t");
        let val = null;
        if (t === "s") { const v = c.getElementsByTagName("v")[0]; val = v ? (shared[+v.textContent] ?? "") : ""; }
        else if (t === "inlineStr") { const is = c.getElementsByTagName("t")[0]; val = is ? is.textContent : ""; }
        else { const v = c.getElementsByTagName("v")[0]; val = v ? v.textContent : null; }
        cells[ref ? XLSX_COL(ref) : cells.length] = val;
      }
      rows.push(cells);
    }
    return rows;
  }

  // Read an .xlsx ArrayBuffer into { sheetName: rows[][] }.
  async function readXlsxSheets(buf) {
    const zip = zipIndex(buf);
    const shared = xlsxSharedStrings(await zipReadText(zip, "xl/sharedStrings.xml"));
    const wb = new DOMParser().parseFromString(await zipReadText(zip, "xl/workbook.xml"), "application/xml");
    const relsDoc = new DOMParser().parseFromString(await zipReadText(zip, "xl/_rels/workbook.xml.rels"), "application/xml");
    const relTarget = {};
    for (const r of relsDoc.getElementsByTagName("Relationship")) relTarget[r.getAttribute("Id")] = r.getAttribute("Target");
    const sheets = {};
    for (const s of wb.getElementsByTagName("sheet")) {
      const name = s.getAttribute("name");
      const rid = s.getAttribute("r:id") || s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
      let tgt = relTarget[rid];
      if (!name || !tgt) continue;
      tgt = tgt.replace(/^\//, "");
      if (!/^xl\//.test(tgt)) tgt = "xl/" + tgt;
      sheets[name] = xlsxSheetRows(await zipReadText(zip, tgt), shared);
    }
    return sheets;
  }

  // Reduce a parsed PMST workbook to the Matters of National Environmental
  // Significance. Heritage/Ramsar/GBRMP/CMA are listed in full; communities and
  // species are filtered to those recorded as "Known" (in the "Simple Presence"
  // or "Rank" column) per the request — Likely/May are counted but not listed.
  function parsePmstMnes(sheets) {
    const norm = (v) => (v == null ? "" : String(v)).trim();
    const lc = (v) => norm(v).toLowerCase();
    const KNOWN = "known";

    function table(name, tokens) {
      const rows = sheets[name];
      if (!rows) return null;
      let hi = -1;
      for (let i = 0; i < rows.length; i++) {
        const cells = (rows[i] || []).map(lc);
        if (tokens.some((t) => cells.includes(t))) { hi = i; break; }
      }
      if (hi < 0) return null;
      const headers = (rows[hi] || []).map(norm);
      const col = (...names) => {
        for (const nm of names) { const idx = headers.findIndex((h) => lc(h) === lc(nm)); if (idx >= 0) return idx; }
        return -1;
      };
      const data = [];
      for (let i = hi + 1; i < rows.length; i++) {
        const r = rows[i] || [];
        if (r.slice(0, headers.length).every((c) => norm(c) === "")) continue;
        data.push(r);
      }
      return { data, col };
    }
    const cell = (r, i) => (i >= 0 ? norm(r[i]) : "");
    const cats = [];

    let t = table("World Heritage", ["place name"]);
    let items = [];
    if (t) for (const r of t.data) {
      const nm = cell(r, t.col("Place Name")); if (!nm) continue;
      const st = cell(r, t.col("State")), legal = cell(r, t.col("Legal Status"));
      items.push(nm + (st ? ` (${st})` : "") + (legal ? ` — ${legal}` : ""));
    }
    cats.push({ title: "World Heritage Properties", items });

    t = table("National Heritage", ["place name"]); items = [];
    if (t) for (const r of t.data) {
      const nm = cell(r, t.col("Place Name")); if (!nm) continue;
      const st = cell(r, t.col("State")), tail = [cell(r, t.col("Heritage Class")), cell(r, t.col("Legal Status"))].filter(Boolean).join("; ");
      items.push(nm + (st ? ` (${st})` : "") + (tail ? ` — ${tail}` : ""));
    }
    cats.push({ title: "National Heritage Places", items });

    t = table("Ramsar Wetlands", ["ramsar site name"]); items = [];
    if (t) for (const r of t.data) {
      const nm = cell(r, t.col("Ramsar Site Name")); if (!nm) continue;
      const prox = cell(r, t.col("Proximity"));
      items.push(nm + (prox ? ` — ${prox}` : ""));
    }
    cats.push({ title: "Wetlands of International Importance (Ramsar)", items });

    t = table("GBRMP", ["zone type", "zone id"]); items = [];
    if (t) for (const r of t.data) {
      const zt = cell(r, t.col("Zone Type")), st = cell(r, t.col("State")); if (!zt && !st) continue;
      items.push([zt, st && `(${st})`, cell(r, t.col("IUCN")) && `IUCN ${cell(r, t.col("IUCN"))}`].filter(Boolean).join(" "));
    }
    cats.push({ title: "Great Barrier Reef Marine Park", items });

    t = table("CMA", ["feature name"]); items = [];
    if (t) for (const r of t.data) { const nm = cell(r, t.col("Feature Name")); if (nm) items.push(nm); }
    cats.push({ title: "Commonwealth Marine Area", items });

    // Structured "Known" captures, kept alongside the display strings so the
    // importer can seed the Threatened Habitat/Flora/Fauna section narratives.
    const rawCommunities = [], rawSpecies = [], rawMigratory = [];

    t = table("Communities", ["community name"]); items = []; let total = 0;
    if (t) for (const r of t.data) {
      const nm = cell(r, t.col("Community Name")); if (!nm) continue; total++;
      if (lc(cell(r, t.col("Rank", "Simple Presence", "Presence"))) !== KNOWN) continue;
      const catg = cell(r, t.col("Threatened Category")), txt = cell(r, t.col("Text", "Presence Text"));
      rawCommunities.push({ name: nm, cat: catg });
      items.push(nm + (catg ? ` — ${catg}` : "") + (txt ? ` [${txt}]` : ""));
    }
    cats.push({ title: "Listed Threatened Ecological Communities", items, total, knownOnly: true, unit: "communities" });

    t = table("Threatened Sp", ["scientific name"]); items = []; total = 0;
    if (t) for (const r of t.data) {
      const sci = cell(r, t.col("Scientific Name")), common = cell(r, t.col("Common Name"));
      if (!sci && !common) continue; total++;
      if (lc(cell(r, t.col("Simple Presence", "Rank", "Presence"))) !== KNOWN) continue;
      const name = common && lc(common) !== "null" ? `${common} (${sci})` : sci;
      const cls = cell(r, t.col("Class")), catg = cell(r, t.col("Threatened Category"));
      const tail = [cls, catg].filter(Boolean).join(", ");
      const txt = cell(r, t.col("Presence Text", "Text"));
      rawSpecies.push({ name, cls, cat: catg });
      items.push(name + (tail ? ` — ${tail}` : "") + (txt ? ` [${txt}]` : ""));
    }
    cats.push({ title: "Listed Threatened Species", items, total, knownOnly: true, unit: "species" });

    t = table("Migratory Sp", ["scientific name"]); items = []; total = 0;
    if (t) for (const r of t.data) {
      const sci = cell(r, t.col("Scientific Name")), common = cell(r, t.col("Common Name"));
      if (!sci && !common) continue; total++;
      if (lc(cell(r, t.col("Rank", "Simple Presence", "Presence"))) !== KNOWN) continue;
      const name = common && lc(common) !== "null" ? `${common} (${sci})` : sci;
      const cls = cell(r, t.col("Class")), txt = cell(r, t.col("Text", "Presence Text"));
      rawMigratory.push({ name, cls });
      items.push(name + (cls ? ` — ${cls}` : "") + (txt ? ` [${txt}]` : ""));
    }
    cats.push({ title: "Listed Migratory Species", items, total, knownOnly: true, unit: "species" });

    let generated = "";
    for (const row of sheets.Summary || []) {
      for (const c of row || []) {
        const s = norm(c);
        if (/report generated/i.test(s)) { generated = s.replace(/^.*generated\s*-?\s*/i, "").replace(/\s*-\s*/g, ", ").trim(); break; }
      }
      if (generated) break;
    }

    const L = ["EPBC Protected Matters Search Tool — Matters of National Environmental Significance"];
    if (generated) L.push(`PMST report generated ${generated}.`);
    L.push("");
    let found = false;
    for (const c of cats) {
      if (c.knownOnly) {
        if (c.items.length) { found = true; L.push(`${c.title} — "Known" only (${c.items.length} of ${c.total}):`); c.items.forEach((it) => L.push(`  • ${it}`)); }
        else L.push(`${c.title} — "Known" only: none${c.total ? ` (${c.total} ${c.unit} returned at Likely/May — excluded)` : ""}`);
      } else {
        if (c.items.length) { found = true; L.push(`${c.title} (${c.items.length}):`); c.items.forEach((it) => L.push(`  • ${it}`)); }
        else L.push(`${c.title}: none returned`);
      }
      L.push("");
    }
    while (L.length && L[L.length - 1] === "") L.pop();
    const seeds = buildPmstSeeds({ communities: rawCommunities, species: rawSpecies, migratory: rawMigratory }, state.site);
    return { text: L.join("\n"), found, seeds };
  }

  async function importPmstXlsx(sourceId, file, btn) {
    const orig = btn ? btn.innerHTML : "";
    if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spin"></span> Reading…`; }
    try {
      const sheets = await readXlsxSheets(await file.arrayBuffer());
      if (!sheets.Summary && !sheets["Threatened Sp"])
        throw new Error("That doesn't look like a PMST export — expected the standard Protected Matters sheets.");
      const res = parsePmstMnes(sheets);
      const f = state.findings[sourceId] || (state.findings[sourceId] = { status: STATUS.UNSET, note: "", result: null, images: [], reviewed: false });
      let note = res.text;
      if (f.note && f.note.trim()) {
        const replace = confirm("This card already has notes.\n\nOK = replace them with the imported PMST summary.\nCancel = keep your notes and add the summary above them.");
        if (!replace) note = res.text + "\n\n——— Existing notes ———\n" + f.note;
      }
      f.note = note;
      f.status = res.found ? STATUS.FOUND : STATUS.NONE;
      // Seed the Threatened Habitat / Flora / Fauna section narratives from the
      // split PMST result, mirroring what a human writes by hand into those
      // sections — but only where the reviewer hasn't already written that
      // section (never clobber their text). Choice defaults to the "…local area"
      // wording, since a 50 km buffer speaks to the wider region, not the footprint.
      let seeded = 0;
      if (res.seeds) {
        for (const [secId, seed] of Object.entries(res.seeds)) {
          if (!seed) continue;
          const rs = state.report[secId] || (state.report[secId] = { choice: null, note: "" });
          if (rs.note && rs.note.trim()) continue;
          rs.note = seed.note; rs.choice = seed.choice; seeded++;
        }
      }
      save(); refreshCard(sourceId); renderCollectionStatus(); renderReport();
      toast(res.found
        ? `PMST imported — MNES summary added${seeded ? `, and ${seeded} section narrative${seeded > 1 ? "s" : ""} drafted` : ""}.`
        : "PMST imported — no MNES matters returned.");
    } catch (err) {
      if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = orig; }
      toast(err.message || "Could not read that .xlsx file.");
    }
  }

  // Every source that applies to this site's jurisdiction — internal / login-only
  // working items included. Nothing about this list depends on the UI, which is why
  // the summary card's rollup reads it directly: a marker on the report must not
  // move because a checkbox in the collection header was ticked.
  function applicableSources() {
    const st = state.site.state;
    return DATA.sources.filter((src) =>
      !src.states || src.states[0] === "*" || src.states.includes(st));
  }
  function sourcesForSite() {
    const showInternal = $("#toggle-manual-internal").checked;
    return applicableSources().filter((src) => !(src.internal && !showInternal));
  }

  // ------------------------------------------------------------ onboarding guide
  // "How to work through the list" is onboarding, not furniture. A first-time
  // operator gets it expanded, as a welcome; once they have finished a site it
  // never appears unasked again and lives one ? away in the collection header.
  // Nothing about it is per site, so the record is a browser flag.
  let onboarded = null; // read once, then kept in memory
  function isOnboarded() {
    if (onboarded !== null) return onboarded;
    onboarded = false;
    try {
      // The older key recorded whether the always-on guide was left open. Someone
      // who had already collapsed it has read it — don't hand it back to them.
      onboarded = localStorage.getItem(LS_ONBOARDED) === "1" || localStorage.getItem(LS_GUIDE) === "0";
    } catch (_) {}
    return onboarded;
  }
  // Called the moment a site is finished — everything answered, or exported.
  function markOnboarded() {
    if (isOnboarded()) return;
    onboarded = true;
    try { localStorage.setItem(LS_ONBOARDED, "1"); } catch (_) {}
  }
  function setGuideOpen(open) {
    const guide = $("#dash-guide"), btn = $("#btn-guide");
    if (!guide) return;
    guide.hidden = !open;
    if (btn) {
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.classList.toggle("on", open);
    }
  }
  // Decided when a site is opened rather than on every dashboard tick, so a guide
  // being read is never yanked away mid-sentence by work happening around it.
  function syncGuide() { setGuideOpen(!isOnboarded()); }

  // ---------------------------------------------------------------- dashboard
  function renderDashboard() {
    // The single biggest DOM build in the app — twenty-three cards and several
    // hundred controls. Focus mode doesn't have a dashboard to build it into, and
    // building it into a detached holder would be the "display:none is not the same
    // as not there" mistake in a different costume. Everything it renders is
    // derived, so it is rebuilt from state the moment the workbench comes back.
    if (!workbenchLive()) return;
    const wrap = $("#dashboard-groups");
    wrap.innerHTML = "";
    // A full dashboard render is the "next render" that ends every transient card
    // expansion: the resting view always reflects state, never accumulated clicks.
    CARD_OPEN.expanded.clear();
    const cats = DATA.sourcesMeta.categories;
    const filter = activeFilter();
    const list = sourcesForSite().filter((s) => filter.test(state.findings[s.id] || {}));
    for (const id of Object.keys(cardNumbers)) delete cardNumbers[id];
    dashboardCats.length = 0; // rebuilt below, in render order, for the nav rail
    let n = 0;
    for (const cat of cats) {
      const inCat = sortCards(list.filter((s) => s.category === cat.id));
      if (!inCat.length) continue;
      // id + --cat are what the nav rail jumps to and colours itself with.
      const group = el("div", { class: "group", "data-cat": cat.id, id: `group-${cat.id}` });
      group.style.setProperty("--cat", `var(--cat-${cat.id})`);
      const body = el("div", { class: "group-body", id: `group-body-${cat.id}` });
      inCat.forEach((src) => { cardNumbers[src.id] = ++n; body.append(renderSourceCard(src)); });
      group.append(renderGroupHead(cat, inCat, body.id), body);
      setGroupOpen(group, groupIsOpen(cat.id, groupRollup(inCat)), false);
      wrap.append(group);
      dashboardCats.push(cat.id);
    }
    if (!wrap.children.length)
      wrap.append(el("p", { class: "dash-note", style: "margin:8px 0" }, filter.empty));
    renderCollectionStatus();
    renderRailNav(); // tracks the groups that survived the filter above
  }

  // ------------------------------------------------------------- group headers
  // A collapsed category still has to say what is inside it, so the header carries
  // its own roll-up: how many sources, how many found, how many still need a human.
  // Without it, a finished category is indistinguishable from an untouched one
  // until you have read eight cards.
  function groupRollup(inCat) {
    let found = 0, need = 0;
    for (const src of inCat) {
      const f = state.findings[src.id] || {};
      if (statusOf(f) === STATUS.FOUND) found++;
      if (isOutstanding(f)) need++; // same definition the collection bar counts with
    }
    return { n: inCat.length, found, need };
  }

  function rollupText(roll) {
    const bits = [`${roll.n} source${roll.n === 1 ? "" : "s"}`];
    if (roll.found) bits.push(`${roll.found} found`);
    bits.push(roll.need ? `${roll.need} need you` : "nothing outstanding");
    return bits.join(" · ");
  }

  function renderGroupHead(cat, inCat, bodyId) {
    const roll = groupRollup(inCat);
    const head = el("div", { class: "group-head" },
      el("h3", {}, cat.label),
      el("span", { class: "g-roll" + (roll.need ? "" : " is-clear") },
        roll.need ? null : el("span", { class: "g-tick", "aria-hidden": "true" }, "✓"),
        rollupText(roll)),
      el("span", { class: "g-line" }));
    // The toggle is the header's only control, and it names what it does for a
    // screen reader — "collapse ▾" on its own says nothing about which category.
    const toggle = el("button", {
      type: "button", class: "g-toggle", "aria-controls": bodyId,
      onclick: (e) => toggleGroup(cat.id, e.currentTarget),
    }, el("span", { class: "g-caret", "aria-hidden": "true" }, "▾"));
    toggle.dataset.cat = cat.id;
    head.append(toggle);
    return head;
  }

  // Explicit choice wins; otherwise a category with nothing outstanding folds away
  // ("you are done here"), and one that still needs a human stays open.
  function groupIsOpen(catId, roll) {
    if (anyFilterOn()) return true;
    const explicit = state.groupOpen[catId];
    if (typeof explicit === "boolean") return explicit;
    return roll.need > 0;
  }

  function setGroupOpen(group, open, focusIn) {
    const body = group.querySelector(".group-body");
    const toggle = group.querySelector(".g-toggle");
    const label = group.querySelector(".group-head h3");
    group.classList.toggle("is-collapsed", !open);
    if (body) body.hidden = !open;
    if (toggle) {
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      const name = label ? label.textContent : "this category";
      toggle.setAttribute("aria-label", `${open ? "Collapse" : "Expand"} ${name}`);
      toggle.title = toggle.getAttribute("aria-label");
    }
    // Cards inside a hidden body measure as zero, so their notes and finding clamps
    // can only be sized once the body is on screen again.
    if (open) queueCardMetrics();
    if (open && focusIn && body) {
      const first = body.querySelector(".src-line, .src-expand, button, input, select, textarea, a");
      if (first) first.focus();
    }
  }

  function toggleGroup(catId, toggle) {
    const group = document.getElementById(`group-${catId}`);
    if (!group) return;
    const open = group.classList.contains("is-collapsed");
    state.groupOpen[catId] = open; // an explicit choice from here on, remembered per site
    save();
    setGroupOpen(group, open, false);
    if (toggle && toggle.isConnected) toggle.focus();
  }

  // Keeps the roll-ups honest on the paths that change a result without rebuilding
  // the dashboard (a status tick, an auto-check, an agent run). Deliberately does
  // NOT re-collapse a category the operator has just finished — pulling the cards
  // out from under them mid-click is worse than one stale-looking group, and the
  // next full render folds it away.
  function refreshGroupHeads() {
    const wrap = $("#dashboard-groups");
    if (!wrap || !state.site) return;
    const byId = {};
    for (const src of sourcesForSite()) (byId[src.category] || (byId[src.category] = [])).push(src);
    $$("#dashboard-groups .group").forEach((group) => {
      const cat = group.dataset.cat;
      const shown = $$(".src", group).map((node) => node.dataset.src).filter(Boolean);
      const inCat = (byId[cat] || []).filter((src) => shown.includes(src.id));
      const roll = groupRollup(inCat);
      const node = group.querySelector(".g-roll");
      if (!node) return;
      const kids = [];
      if (!roll.need) kids.push(el("span", { class: "g-tick", "aria-hidden": "true" }, "✓"));
      kids.push(document.createTextNode(rollupText(roll)));
      node.replaceChildren(...kids);
      node.classList.toggle("is-clear", !roll.need);
    });
  }

  // ------------------------------------------------------------------- tabs
  // Step 1's "By station name / By coordinates" pair. The class swap and the ARIA
  // are done in one place, so a tab can never look selected while announcing that
  // it isn't — which is what happened while this was three lines of classList in
  // wire().
  //
  // Roving tabindex, per the ARIA tabs pattern: Tab reaches the tablist once and
  // lands on the selected tab, then ←/→ move between them (wrapping) and Home/End
  // jump the ends. Without it a two-tab strip costs two Tab presses to walk past
  // and gives no key that means "the other one".
  function wireTabs() {
    const tabs = $$(".tab");
    if (!tabs.length) return;
    const select = (tab, focus) => {
      tabs.forEach((t) => {
        const on = t === tab;
        t.classList.toggle("is-active", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
        // Only the selected tab is in the tab order.
        if (on) t.removeAttribute("tabindex"); else t.setAttribute("tabindex", "-1");
      });
      $$(".tab-panel").forEach((p) => p.classList.toggle("is-active", p.dataset.panel === tab.dataset.tab));
      if (focus) tab.focus();
    };
    tabs.forEach((t) => t.addEventListener("click", () => select(t)));
    tabs.forEach((t) => t.addEventListener("keydown", (e) => {
      const i = tabs.indexOf(t);
      const to = e.key === "ArrowRight" ? (i + 1) % tabs.length
        : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length
        : e.key === "Home" ? 0
        : e.key === "End" ? tabs.length - 1 : -1;
      if (to < 0) return;
      e.preventDefault();
      select(tabs[to], true);
    }));
  }

  // ---------------------------------------------------------------- nav rail
  // The narrow jump rail on the left edge of the split: the four numbered steps,
  // then one button per visible dashboard group, each carrying a count of the
  // sources in that category a human still owns. It answers "where am I / what's
  // left" without scrolling, which is the whole reason it earns its 44px.
  //
  // The glyphs live here rather than in sources.json because they're presentation
  // only, and sources.json is shared with the ess-collect skill.
  const CAT_GLYPH = {
    permits: "🔑", biosecurity: "🛡", threatened: "🦎", indigenous_heritage: "🏛",
    invasive_plants: "🌾", invasive_animals: "🐗", disease: "🦠", additional: "📎",
  };
  const RAIL_STEPS = [
    // Step 1 is folded away while a site is open, so its rail button un-folds it
    // rather than scrolling to something that isn't there.
    { id: "site-picker", step: "1", label: "Choose a site", act: showSitePicker },
    { id: "site-summary", step: "2", label: "Check the site details" },
    { id: "run-checks", step: "3", label: "Run the checks" },
    { id: "dashboard", step: "4", label: "Finish & include each source" },
  ];
  const dashboardCats = []; // category ids currently on the dashboard, in render order
  let railObserver = null;

  function railScrollTo(id) {
    const target = document.getElementById(id);
    if (!target) return;
    // #col-left is the scroll container on the wide layout, so this scrolls the
    // column rather than the page. jumpTo() carries the focus move and the
    // reduced-motion check.
    jumpTo(target);
  }

  function renderRailNav() {
    // The rail's narrow-layout counterpart is rebuilt from the same state, on the
    // same trigger, so the two can never drift apart. It handles the no-site case
    // itself, hence the call before the early return below.
    renderMobileNav();
    const rail = $("#railnav");
    if (!rail) return;
    if (railObserver) { railObserver.disconnect(); railObserver = null; }
    rail.innerHTML = "";
    // Matches #workspace — there's nothing to jump to until a site is loaded, and
    // nothing to navigate at all while Focus mode has the screen (its own step list
    // is what does this job there).
    const live = workbenchLive() && !!state.site && !$("#workspace").hidden;
    rail.hidden = !live;
    if (!live) return;

    const catById = {};
    for (const c of (DATA.sourcesMeta && DATA.sourcesMeta.categories) || []) catById[c.id] = c;
    const attention = railAttentionCounts();

    const targets = [];
    const railBtn = (id, label, body, act) => {
      const btn = el("button", {
        type: "button", class: "rail-btn", "data-target": id, "aria-label": label,
        onclick: act || (() => railScrollTo(id)),
      }, body,
      // The visible name, on hover AND on focus — see .rail-label. aria-hidden
      // because the button's aria-label already says the same thing.
      el("span", { class: "rail-label", "aria-hidden": "true" }, label));
      targets.push(id);
      return btn;
    };

    for (const s of RAIL_STEPS)
      rail.append(railBtn(s.id, `${s.step}. ${s.label}`, el("span", { class: "step", "aria-hidden": "true" }, s.step), s.act));

    if (dashboardCats.length) rail.append(el("div", { class: "rail-sep" }));
    for (const id of dashboardCats) {
      const cat = catById[id];
      if (!cat) continue;
      const btn = railBtn(`group-${id}`, cat.label, el("span", { "aria-hidden": "true" }, CAT_GLYPH[id] || "•"));
      btn.dataset.cat = id;
      btn.style.setProperty("--cat", `var(--cat-${id})`);
      setRailBadge(btn, cat.label, attention[id] || 0);
      rail.append(btn);
    }

    wireRailSpy(targets);
  }

  // Attention counts come from the site's whole source list, not the filtered view,
  // so a badge keeps answering "what's left in this category" while a filter is on.
  function railAttentionCounts() {
    const counts = {};
    for (const src of sourcesForSite())
      if (isOutstanding(state.findings[src.id] || {}))
        counts[src.category] = (counts[src.category] || 0) + 1;
    return counts;
  }

  // A rail of bare emoji is unusable, so the category name and the count are said
  // twice over: in the accessible name, and in the fly-out label that appears on
  // hover or keyboard focus. The badge itself is decoration — it repeats a number
  // both of those already carry.
  function setRailBadge(btn, label, n) {
    const old = btn.querySelector(".rail-badge");
    if (old) old.remove();
    const full = label + (n ? ` — ${n} still need you` : "");
    btn.setAttribute("aria-label", full);
    const flyout = btn.querySelector(".rail-label");
    if (flyout) flyout.textContent = full;
    // After the label, so the badge keeps its place as the last child.
    if (n) btn.append(el("span", { class: "rail-badge", "aria-hidden": "true" }, `${n}`));
  }

  // Badge-only refresh, run from renderCollectionStatus() so every path that changes a
  // result (a click, an auto-check, an agent run, an import) keeps the counts live
  // without rebuilding the rail or its observer.
  function refreshRailBadges() {
    const rail = $("#railnav");
    if (!rail || rail.hidden || !state.site) return;
    const counts = railAttentionCounts();
    const catById = {};
    for (const c of (DATA.sourcesMeta && DATA.sourcesMeta.categories) || []) catById[c.id] = c;
    rail.querySelectorAll(".rail-btn[data-cat]").forEach((btn) => {
      const cat = catById[btn.dataset.cat];
      if (cat) setRailBadge(btn, cat.label, counts[btn.dataset.cat] || 0);
    });
  }

  // Scroll-spy: one observer over the four fixed sections + every group, watching a
  // band across the TOP of the scrolling column — the same place the sticky group
  // header pins, so the rail always agrees with the heading on screen. (A mid-column
  // band reads badly here: sections shorter than half a screen never reach it, so
  // clicking a rail button could leave the button below it marked.)
  function wireRailSpy(targets) {
    if (!("IntersectionObserver" in window)) return;
    const nodes = targets.map((id) => document.getElementById(id)).filter(Boolean);
    if (!nodes.length) return;

    // One spy, two navigations: the rail on the wide layout and the chip row on the
    // narrow one both mean "you are here", so they are marked from the same place
    // rather than each growing an observer of its own.
    const setActive = (id) => {
      $$(".rail-btn, .mjump-btn").forEach((b) => {
        const on = b.dataset.target === id;
        b.classList.toggle("is-active", on);
        if (on) b.setAttribute("aria-current", "true");
        else b.removeAttribute("aria-current");
      });
    };

    // How deeply each target nests inside the others: the groups live inside
    // #dashboard, so when both are in the band the group is the more specific — and
    // more useful — answer to "where am I".
    const depth = {};
    for (const node of nodes) depth[node.id] = nodes.filter((o) => o !== node && o.contains(node)).length;

    const inBand = new Set();
    railObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) inBand.add(e.target.id);
        else inBand.delete(e.target.id);
      }
      // Deepest wins; among equals the first in document order wins, so a short
      // section doesn't hand the marker to the one below it. Nothing in the band
      // (mid-jump) keeps the previous marker rather than flickering off.
      let pick = null, pickDepth = -1;
      for (const id of targets) {
        if (!inBand.has(id) || depth[id] <= pickDepth) continue;
        pick = id; pickDepth = depth[id];
      }
      if (pick) setActive(pick);
    }, spyBand());
    nodes.forEach((node) => railObserver.observe(node));
  }

  // Where "you are here" is measured. On the wide layout the left column is its own
  // scroll container, so it is the root and the band is the top of that column.
  // Below 981px the page scrolls instead: the root is the viewport, and the band
  // has to start below the topbar and the tab shell — otherwise the marker names
  // whichever section is hidden *behind* them rather than the first one on screen.
  // Rebuilt on the breakpoint change (see syncNarrowRoles) so it never observes
  // against the layout the window has just left.
  function spyBand() {
    if (!narrowLayout()) return { root: $("#col-left"), rootMargin: "0px 0px -85% 0px", threshold: 0 };
    const px = (name) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;
    const top = Math.round(px("--topbar-h") + px("--mshell-h"));
    return { root: null, rootMargin: `-${top}px 0px -75% 0px`, threshold: 0 };
  }

  /* ------------------------------------------------------- Queensland Globe map
     The "Open site map" button on the Queensland Globe card hands off to
     assets/qldmap.js, which draws a real ArcGIS map of the site over the
     published Queensland Government services. Everything the operator does in
     there comes back through two callbacks:
       onChange — the layer ticks; persisted so re-opening restores the stack
       onAdd    — a captured map: the picture goes into the card's images (so it
                  follows the normal report/export path) and the LAYER LIST goes
                  into state.qldMap.capture, which the report renders as an
                  appendix rather than cluttering the body or the picture.
     A site outside Queensland never gets the button, so this is only ever
     reached for QLD sites. */
  function openQldGlobeMap(src) {
    if (!state.site || state.site.state !== "QLD") return;
    if (!window.ESSQldMap) { toast("The map module didn't load — reload the page and try again."); return; }
    const qm = state.qldMap || (state.qldMap = { selection: null, capture: null });
    window.ESSQldMap.open({
      site: { name: state.site.name, station_num: state.site.station_num, lat: state.site.lat, lon: state.site.lon },
      selection: qm.selection,
      capture: qm.capture,
      onChange: (selection) => { qm.selection = selection; save(); },
      onAdd: (record) => {
        const f = state.findings[src.id] || (state.findings[src.id] = { status: STATUS.UNSET, note: "", result: null, images: [] });
        if (!f.images) f.images = [];
        // One Queensland Globe map per site: a second capture REPLACES the first
        // rather than stacking near-identical maps through the report.
        f.images = f.images.filter((im) => !String(im.id || "").startsWith("qldmap-"));
        f.images.push({
          id: `qldmap-${Date.now()}`,
          dataUrl: record.dataUrl,
          caption: record.caption,
          ts: record.at || Date.now(),
        });
        f.included = true;
        if (f.status === STATUS.UNSET) f.status = STATUS.FOUND;
        // The appendix record. Kept separately from the image so it survives an
        // image being deleted, and so an imported findings file can rebuild the
        // appendix without the picture.
        qm.capture = {
          at: record.at || Date.now(),
          caption: record.caption,
          lat: record.meta && record.meta.lat, lon: record.meta && record.meta.lon,
          scale: record.meta && record.meta.scale,
          pin_in_view: !!(record.meta && record.meta.pinInView),
          layers: record.layers || [],
        };
        saveImages(); save();
        refreshCard(src.id); renderCollectionStatus(); renderReport();
        toast(`Map added to the report — ${(record.layers || []).length} layers recorded in the appendix`);
      },
    });
  }

  // Paint a card's "what came back" panel: an explicit label above the source's
  // own words, tinted to the result they produced. This is the highest-value text
  // on the card — it is what the machine actually found — and the label plus the
  // tint are what stop it being read as the operator's own note or as the static
  // "what to look for" caption. Used by the card renderer and by the live checks
  // while they are still in flight (label: "Checking").
  function paintResult(node, html, opts) {
    if (!node) return;
    const o = opts || {};
    const tint = o.err ? " err"
      : (o.status && o.status !== STATUS.UNSET) ? ` status-${o.status}` : "";
    node.className = `src-result show${tint}`;
    node.replaceChildren(
      el("span", { class: "src-result-label" }, o.label || "What came back"),
      el("div", { class: "src-result-body", html: html || "" }));
    queueCardMetrics();
  }

  // ---------------------------------------------------------------- card metrics
  // Two things a card can only get right once it has been laid out: how tall the
  // note needs to be, and whether the finding actually overflows its four-line
  // clamp. Both are read in one batched frame after a render rather than per card,
  // so building 23 cards costs one forced layout instead of 46.
  let cardMetricsQueued = false;
  function queueCardMetrics() {
    if (cardMetricsQueued) return;
    cardMetricsQueued = true;
    requestAnimationFrame(() => { cardMetricsQueued = false; syncCardMetrics(); });
  }

  function syncCardMetrics() {
    // Three passes rather than one: writing and reading a height per textarea in
    // the same loop forces a reflow per card. Reset every one, measure every one,
    // then write — two reflows for the whole dashboard.
    // Both modes' notes: exactly one of the two selectors can match at a time, and
    // a Focus step's single note wants sizing for the same reason 23 cards' do.
    const notes = $$("#dashboard-groups .note-field, #focus .note-field");
    notes.forEach((ta) => { ta.style.height = "auto"; });
    const heights = notes.map((ta) => Math.max(ta.scrollHeight, 28));
    notes.forEach((ta, i) => { ta.style.height = `${heights[i]}px`; });
    // Clamping is the dashboard's alone — a Focus step shows the finding in full.
    $$("#dashboard-groups .src-result.show").forEach(syncResultClamp);
  }

  // A note grows to fit what's in it. Most cards carry a line or none at all, and
  // a fixed 3-row box on each of 23 cards is ~450 px of empty field.
  function autoGrow(ta) {
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.max(ta.scrollHeight, 28)}px`;
  }

  // The finding is clamped to four lines in CSS; this only decides whether the
  // card needs a "Show all" at all. Measured, not guessed from text length — the
  // pane is resizable, so the same result wraps to two lines or six depending on
  // how the operator has the split set. A card whose finding fits never carries
  // the control.
  function syncResultClamp(panel) {
    const body = panel.querySelector(".src-result-body");
    if (!body || panel.classList.contains("is-open")) return;
    const over = body.scrollHeight - body.clientHeight > 2;
    const existing = panel.querySelector(".src-result-more");
    if (!over) { if (existing) existing.remove(); return; }
    if (existing) return;
    panel.append(el("button", {
      type: "button", class: "src-result-more", "aria-expanded": "false",
      onclick: (e) => {
        const open = !panel.classList.contains("is-open");
        panel.classList.toggle("is-open", open);
        e.target.textContent = open ? "Show less" : "Show all";
        e.target.setAttribute("aria-expanded", open ? "true" : "false");
      },
    }, "Show all"));
  }

  // The card, at whichever of the three densities its state asks for. A card the
  // operator has answered, routed into the report and ticked off has nothing
  // actionable left on it, so it stops costing 260 px and a dozen controls; one
  // click brings the whole card back, and the next full render settles it again.
  function renderSourceCard(src) {
    const f = state.findings[src.id] || (state.findings[src.id] = { status: STATUS.UNSET, note: "", result: null, images: [], reviewed: false });
    if (!f.images) f.images = [];
    const resting = cardDensity(f);
    if (resting !== "full" && !CARD_OPEN.expanded.has(src.id))
      return resting === "line" ? renderLineCard(src, f) : renderSummaryCard(src, f);
    return renderFullCard(src, f, resting !== "full");
  }

  // The shell every density shares: the status edge, the reviewed tint, the
  // category colour the monogram picks up, and the id the rail and the report's
  // cross-pane jumps both scroll to.
  //
  // data-section is the other half of the split view: it names the report section
  // this card feeds, and it is what the reciprocal highlight and the scroll sync
  // both read. Every density carries it, so the relationship survives a card
  // settling down to one line.
  function cardShell(src, f, density) {
    const card = el("div", {
      class: `src status-${f.status} density-${density}${f.reviewed ? " is-reviewed" : ""}`,
      id: `src-${src.id}`, "data-src": src.id, "data-density": density,
      "data-section": targetSectionOf(src, f) || null,
    });
    card.style.setProperty("--cat", `var(--cat-${src.category})`);
    return card;
  }

  // The card's sign-off. Deliberately NOT the report pane's "Mark reviewed"
  // checkbox: they are separate tallies, and rendering them identically was the
  // single most confusing thing on the page. Different word ("sign off" vs
  // "reviewed"), different control (a pressed pill vs a checkbox), different shape.
  function renderSignOff(src, f) {
    const on = isSignedOff(f);
    return el("button", {
      // The visible label already says what this does, so it carries no title —
      // the accessible name only adds which card, for someone tabbing the list.
      type: "button", class: "signoff" + (on ? " on" : ""), "aria-pressed": on ? "true" : "false",
      "aria-label": on ? `Signed off: ${src.name}` : `Sign off ${src.name}`,
      onclick: () => setReviewed(src.id, !on),
    }, el("span", { class: "signoff-tick", "aria-hidden": "true" }, on ? "✓" : "○"),
      el("span", {}, on ? "Signed off" : "Sign off"));
  }

  // Status as shape + word, never colour alone: the glyph differs per result, and
  // the accessible name spells it out. The shapes themselves live in styles.css
  // (--glyph-*, drawn by .s-dot::before) so that this dot, the status chips, the
  // finding panel's label and the result picker cannot end up using the same
  // shape for two different results.
  function statusDot(status) {
    return el("span", { class: `s-dot ${STATUS_LABEL[status] ? status : "unset"}`, "aria-hidden": "true" });
  }
  function sectionTitleOf(src, f) {
    const id = targetSectionOf(src, f);
    const sec = REPORT_SECTIONS.find((s) => s.id === id);
    return sec ? sec.title : "the report";
  }

  // ---- line density — a settled card ------------------------------------
  // One row: number, result, name, where it lands in the report, and the tick.
  // The whole row is a button, so it is in the tab order and Enter/Space opens it
  // (and there is no dropzone on it to silently swallow a pasted screenshot).
  function renderLineCard(src, f) {
    const card = cardShell(src, f, "line");
    const num = cardNumbers[src.id];
    const sec = sectionTitleOf(src, f);
    card.append(el("button", {
      // aria-expanded alone: what expands is the card this button is inside, so
      // there is no sibling region for aria-controls to point at.
      type: "button", class: "src-line", "aria-expanded": "false",
      "aria-label": `${src.name} — ${STATUS_LABEL[f.status]}, signed off, feeding ${sec}. Expand to change it.`,
      onclick: () => expandCard(src.id),
    },
      el("span", { class: "src-num" }, num ? `${num}` : ""),
      statusDot(f.status),
      el("span", { class: "src-line-name" }, src.name),
      el("span", { class: "src-line-sec" }, `→ ${sec}`),
      el("span", { class: "src-line-tick", "aria-hidden": "true" }, "✓"),
      el("span", { class: "src-caret", "aria-hidden": "true" }, "▾")));
    return card;
  }

  // ---- summary density — answered, not yet reviewed ----------------------
  // Identity, the first two lines of what came back, the result, and the one
  // action that is actually outstanding on this card: ticking it off. Clicking
  // anywhere that isn't a control opens the full card.
  function renderSummaryCard(src, f) {
    const card = cardShell(src, f, "summary");
    const num = cardNumbers[src.id];
    const expand = el("button", {
      type: "button", class: "src-expand", "aria-expanded": "false",
      "aria-label": `Expand ${src.name} — ${STATUS_LABEL[f.status]}`,
      onclick: () => expandCard(src.id),
    }, el("span", { class: "src-caret", "aria-hidden": "true" }, "▾"));

    // Prefer the operator's own words when they've written any — that's what the
    // report will carry — and fall back to the machine's finding.
    const own = (f.note || "").trim();
    const raw = own || (f.result ? f.result.html : "");
    const mini = raw
      ? el("div", { class: "src-mini" },
        el("span", { class: "src-mini-label" }, own ? "Your note" : "What came back"),
        el("div", { class: "src-mini-body", html: own ? esc(own).replace(/\n/g, " ") : raw }))
      : null;

    const included = cardIncluded(f);

    card.append(
      el("div", { class: "src-top" },
        el("div", { class: "src-name" },
          el("span", { class: "src-num" }, num ? `${num}` : ""),
          renderSourceIcon(src),
          src.name),
        el("span", { class: `chip ${f.status}` }, STATUS_LABEL[f.status]),
        expand),
      mini,
      el("div", { class: "src-sum-foot" },
        el("span", { class: "src-line-sec" }, `→ ${sectionTitleOf(src, f)}`),
        el("span", { class: "src-sum-inc" + (included ? " is-in" : "") }, included ? "✓ In report" : "not included"),
        renderSignOff(src, f)));

    // Anywhere that isn't a control opens the card in place.
    card.addEventListener("click", (e) => {
      if (e.target.closest("button, a, input, select, textarea, label")) return;
      expandCard(src.id);
    });
    return card;
  }

  // Transiently open a collapsed card. Nothing about this is persisted: the next
  // full dashboard render clears it, so the resting view keeps reflecting state
  // rather than the operator's click history.
  function expandCard(id) {
    CARD_OPEN.expanded.add(id);
    refreshCard(id);
    const card = $(`#src-${id}`);
    const back = card && card.querySelector(".src-collapse");
    if (back) back.focus(); // focus lands inside the card it just opened
  }

  function collapseCard(id) {
    CARD_OPEN.expanded.delete(id);
    refreshCard(id);
    const card = $(`#src-${id}`);
    const btn = card && card.querySelector(".src-line, .src-expand");
    if (btn) btn.focus(); // …and comes back to the card on the way out
  }

  // A source card is read in three zones, in the order the operator forms an
  // opinion — identity → finding → disposition:
  //
  //   IDENTITY     which source is this, and (behind ⓘ) what am I looking for
  //   FINDING      what came back · my note · my photos
  //   DISPOSITION  record the result → go look → route it to the report → done
  //
  // Everything that is reference material rather than decision material lives
  // behind the ⓘ affordance or the ⋯ overflow, and is built only when opened —
  // 23 cards' worth of always-on prose and buttons is what made the pane feel
  // like a wall. Nothing was removed: every capability is one click away.
  function renderFullCard(src, f, collapsible) {
    const card = cardShell(src, f, "full");
    if (collapsible) card.classList.add("is-expanded"); // opened above its resting density
    const num = cardNumbers[src.id];

    // ---- zone 1: identity ------------------------------------------------
    // Number, monogram, name — plus ⓘ, which is where the jurisdiction/method
    // tags and the static "what to look for" prose went. They read identically
    // on every run and every site, so they earn a disclosure, not 23 permanent
    // copies down the pane.
    const about = el("div", { class: "src-about", id: `about-${src.id}`, hidden: true });
    const aboutBtn = el("button", {
      type: "button", class: "src-info", "aria-expanded": "false", "aria-controls": about.id,
      "aria-label": `About ${src.name} — what to look for, and where it comes from`,
      onclick: () => setAbout(src, aboutBtn, about, about.hidden),
    }, "ⓘ");
    // A card is rebuilt whenever anything on it changes (a status tick, a photo
    // landing); an open disclosure survives that rather than snapping shut under
    // the operator.
    if (CARD_OPEN.about.has(src.id)) setAbout(src, aboutBtn, about, true);

    // ---- zone 2: the finding ---------------------------------------------
    // What came back, first and labelled. Long results are clamped to four lines
    // with a Show all toggle (added by syncCardMetrics once it can measure).
    const resultPanel = el("div", { class: "src-result", id: `res-${src.id}` });
    if (f.result) paintResult(resultPanel, f.result.html, { status: f.status, err: f.result.err });

    // oninput fires per keystroke (save + regrow); onchange fires on blur, and
    // re-renders the report so the edited note lands in its target section live
    // (the report is a separate DOM tree, so rebuilding it never disturbs a click
    // on this card). Editing the notes NEVER triggers a Wikipedia image search —
    // that turned every note edit into a burst of network fetches + canvas work.
    // Reference photos are pulled only on explicit request, from + Add photo.
    const note = el("textarea", {
      class: "note-field", rows: "1",
      "aria-label": `Your note on ${src.name}`,
      placeholder: "Your own words for the report…",
      oninput: (e) => { f.note = e.target.value; save(); autoGrow(e.target); },
      onchange: () => { renderReport(); },
    });
    note.value = f.note || "";
    // Photos belong to the note — they are the operator's other evidence — so the
    // "+ Add photo" affordance rides on the note's own label row rather than
    // costing the card a row of its own.
    const photos = PHOTO_CATEGORIES.has(src.category) ? renderPhotoBlock(src, f) : null;
    const noteBlock = el("div", { class: "src-note" },
      el("div", { class: "note-head" },
        el("span", { class: "zone-label" }, "Your note"),
        photos ? photos.addBtn : null),
      note,
      photos ? photos.body : null);

    // ---- zone 3: disposition ---------------------------------------------
    // The card's ONE primary. Whatever else a card can do, going and looking at
    // the source is what the operator opened it for — and the click copies the
    // coordinates on the way out, so the site's search box can be filled by
    // paste. Every other action here is secondary, tertiary or in the ⋯.
    const link = el("a", {
      href: buildUrl(src), target: "_blank", rel: "noopener", class: "btn tiny primary",
      onclick: () => copy(`${state.site.lat}, ${state.site.lon}`, "Coordinates copied"),
    }, "Open the source ↗");

    // The one thing about this app's vocabulary an operator has to be told, told at
    // the point of use rather than in a paragraph 300 px up the pane that is read
    // once and never again (it used to be step 4 of the instruction block).
    const resultHint = el("p", { class: "do-hint", id: `hint-${src.id}`, hidden: true },
      "Found ≠ good news — a protected species means caution on site. Sign-off is your judgement about this card, tracked separately from the result.");
    const resultLead = el("button", {
      type: "button", class: "do-lead do-lead-info", "aria-expanded": "false", "aria-controls": resultHint.id,
      title: "What Result means, and how it relates to sign-off",
      onclick: () => {
        const open = resultHint.hidden;
        resultHint.hidden = !open;
        resultLead.setAttribute("aria-expanded", open ? "true" : "false");
        resultLead.classList.toggle("on", open);
        queueCardMetrics();
      },
    }, "Result", el("span", { class: "do-lead-mark", "aria-hidden": "true" }, "ⓘ"));

    // The specialist tools — a map, a live API, an Excel import. They appear on
    // one to three cards in a whole assessment, so they earn their place in the
    // row, but they are alternatives to "open the source", not the point of the
    // card: secondary, never a second filled button competing with the primary.
    const doRow = el("div", { class: "do-row" }, resultLead, renderStatusControl(src, f), link);
    if (src.id === "qld-globe" && state.site.state === "QLD") {
      doRow.append(el("button", { type: "button", class: "btn tiny secondary", onclick: () => openQldGlobeMap(src) }, "Open site map"));
    }
    const runner = apiRunnerFor(src);
    if (runner) doRow.append(el("button", { class: "btn tiny secondary", id: `run-${src.id}`, onclick: () => runner(src) }, "Check live"));
    // PMST card: upload the tool's Excel export and extract the MNES summary in-browser.
    if (src.xlsx_import === "pmst_mnes") {
      const fileInput = el("input", {
        type: "file", accept: ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", hidden: true,
        onchange: (e) => { const file = e.target.files && e.target.files[0]; if (file) importPmstXlsx(src.id, file, importBtn); e.target.value = ""; },
      });
      const importBtn = el("button", {
        type: "button", class: "btn tiny secondary",
        onclick: () => fileInput.click(),
      }, "Import PMST Excel");
      doRow.append(importBtn, fileInput);
    }
    doRow.append(renderCardMenu(src, note));

    // Only a card opened above its resting density carries a way back — a card that
    // is full because it still needs a human has nothing to collapse to.
    const collapseBtn = collapsible ? el("button", {
      type: "button", class: "src-collapse", "aria-expanded": "true",
      "aria-label": `Collapse ${src.name}`, title: "Collapse",
      onclick: () => collapseCard(src.id),
    }, el("span", { class: "src-caret", "aria-hidden": "true" }, "▴")) : null;

    card.append(
      el("div", { class: "src-top" },
        el("div", { class: "src-name" },
          el("span", { class: "src-num" }, num ? `${num}` : ""),
          renderSourceIcon(src),
          src.name),
        aboutBtn,
        collapseBtn),
      about,
      resultPanel,
      noteBlock,
      el("div", { class: "src-do" }, doRow, resultHint, renderIncludeRow(src)));
    queueCardMetrics();
    return card;
  }

  // Which cards have a disclosure open, by source id — survives the card being
  // re-rendered (which happens on every status tick, include toggle and photo).
  // `expanded` is the same idea one level up: a settled card the operator has
  // opened stays open while they work in it, and renderDashboard() clears the set
  // so the resting view goes back to being state-driven.
  const CARD_OPEN = { about: new Set(), photos: new Set(), expanded: new Set() };

  // The ⓘ disclosure: jurisdiction, how it's queried, what to look for, the steps
  // and the URL. Built on first open — 23 cards of never-read reference prose is
  // 23 cards of DOM nobody asked for.
  function setAbout(src, btn, panel, open) {
    if (open && !panel.childElementCount) {
      const facts = el("div", { class: "src-facts" },
        el("span", { class: "tag jur" }, src.jurisdiction === "national" ? "National" : (state.site.state || "State")),
        src.method === "api"
          ? el("span", { class: "tag api" }, "Queried by API")
          : el("span", { class: "tag method" }, "Checked by hand"));
      if (src.internal) facts.append(el("span", { class: "tag internal" }, "Internal — BOM staff only"));
      panel.append(facts);
      if (src.what_to_find) panel.append(
        el("p", { class: "src-desc" }, el("b", {}, "What to look for: "), src.what_to_find));
      if (src.instructions) panel.append(
        el("p", { class: "src-desc" }, el("b", {}, "How to run it: "), src.instructions));
      const url = buildUrl(src);
      if (url) panel.append(el("a", { class: "src-url", href: url, target: "_blank", rel: "noopener" }, url));
    }
    panel.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.classList.toggle("on", open);
    CARD_OPEN.about[open ? "add" : "delete"](src.id);
  }

  // The card's single status marker. Once a result is recorded it collapses to
  // that one value — the card border, the tinted finding panel and this chip were
  // all saying "found" at once — and clicking it brings the four-way picker back.
  // An unanswered card keeps the picker open: recording the result is the whole
  // job of that card, and it stays one click.
  //
  // `opts.open` holds the picker open at every status. Focus mode passes it: there
  // the step IS the card, recording the result is the step's whole question, and a
  // Manual or Failed source that collapsed to a chip would ask for a click before
  // it could be changed. The workbench keeps the collapse — it is what stops the
  // border, the tinted panel and the chip all shouting "found" at once.
  function renderStatusControl(src, f, opts) {
    const o = opts || {};
    const slot = el("div", { class: "result-slot" });
    // A radiogroup, not four buttons: the four are mutually exclusive and exactly
    // one of them is the card's answer, which `aria-pressed` on four independent
    // toggles cannot say. As four buttons a screen reader announced "Found,
    // button" four times over with nothing tying them together or naming the
    // current choice; as a radiogroup it announces "Result — Nothing, radio
    // button, 2 of 4, selected".
    //
    // Roving tabindex + arrow keys come with the pattern: the group is one Tab
    // stop, ←/→/↑/↓ move through it (wrapping) and select as they go, which is
    // what a keyboard operator answering 23 of these in a row needs. The short
    // visible labels are fine sighted — they sit under a "Result" lead — but
    // read bare in a screen reader's forms list, so each radio carries the full
    // wording as its accessible name.
    const CHOICES = [
      [STATUS.FOUND, "Found", "Found — there is something here"],
      [STATUS.NONE, "Nothing", "Nothing found — checked, and there is nothing"],
      [STATUS.FAILED, "Failed", "Search failed — the check could not be completed"],
      [STATUS.MANUAL, "Manual", "Needs manual check — a human has to drive it"],
    ];
    const picker = () => {
      const sel = el("div", { class: "status-select", role: "radiogroup", "aria-label": `Result for ${src.name}` });
      const radios = CHOICES.map(([s, lab, full], i) => el("button", {
        type: "button", "data-s": s, class: f.status === s ? "on" : "",
        role: "radio", "aria-checked": f.status === s ? "true" : "false",
        "aria-label": full,
        // One Tab stop for the group: the chosen radio, or the first when the
        // card is still unanswered.
        tabindex: (f.status === s || (f.status === STATUS.UNSET && i === 0)) ? "0" : "-1",
        onclick: () => setStatus(src.id, s),
      }, lab));
      sel.addEventListener("keydown", (e) => {
        const i = radios.indexOf(document.activeElement);
        if (i < 0) return;
        const to = (e.key === "ArrowRight" || e.key === "ArrowDown") ? (i + 1) % radios.length
          : (e.key === "ArrowLeft" || e.key === "ArrowUp") ? (i - 1 + radios.length) % radios.length
          : e.key === "Home" ? 0
          : e.key === "End" ? radios.length - 1 : -1;
        if (to < 0) return;
        e.preventDefault();
        // Arrows SELECT; they never toggle. setStatus un-answers a card when it is
        // handed the result it already holds — which is the right thing for a
        // click (it is how you take back an answer) and the wrong thing for a
        // radiogroup, where End on the last option would silently clear the card.
        // Read the live status rather than the closure's `f`, which goes stale the
        // moment the card is re-rendered underneath us.
        const want = CHOICES[to][0];
        if (want !== (state.findings[src.id] || {}).status) setStatus(src.id, want);
        refocusStatus(src.id, want);
      });
      sel.append(...radios);
      return sel;
    };
    if (o.open || f.status === STATUS.UNSET) { slot.append(picker()); return slot; }
    slot.append(el("button", {
      type: "button", class: `chip result-chip ${f.status}`, "aria-expanded": "false",
      "aria-label": `Result: ${STATUS_LABEL[f.status]} — change it`,
      onclick: () => {
        const open = picker();
        slot.replaceChildren(open);
        const on = open.querySelector("button.on");
        if (on) on.focus();
      },
    }, STATUS_LABEL[f.status]));
    return slot;
  }

  // Arrowing through the radiogroup answers the card, and answering a card settles
  // it: the picker collapses to its result chip, and the card itself drops from
  // `full` density to `summary` — so on the very first ← the group the operator is
  // still walking is gone, and focus lands on "Show more". Hold the card open (the
  // same transient set a click on "Show more" uses), put the picker back, and
  // return focus to the radio they just landed on, so ←/→ walk all four.
  function refocusStatus(id, status) {
    CARD_OPEN.expanded.add(id);
    refreshCard(id); // in Focus this re-renders the step instead — see refreshCard
    // Focus has no #src- card: the step is the card, and its picker never collapses,
    // so the radio is found without the chip round trip below.
    const card = focusLive() ? $("#focus") : $(`#src-${id}`);
    if (!card) return;
    const chip = card.querySelector(".result-slot .result-chip");
    if (chip) chip.click(); // swaps the chip back for the picker (see renderStatusControl)
    const radio = card.querySelector(`.status-select [data-s="${status}"]`);
    if (radio) radio.focus();
  }

  // Per-card ⋯ overflow — the fourth action tier. The utilities that were
  // competing with "go look" and "record the answer" at identical weight in the
  // old action row: rare, recoverable, or duplicating something the card already
  // does. Items are built on first open, so a resting card carries one button
  // rather than five, and they are plain text — the ⋯ has already said "more".
  //
  // `opts.handoff` is the Focus step this menu is standing in. Focus's escape hatch
  // to the full card belongs here rather than as a visible button: it is exactly
  // the kind of occasional utility this tier is for, and the step has no row to
  // spare for one.
  function renderCardMenu(src, note, opts) {
    const o = opts || {};
    const list = el("div", { class: "menu-list", role: "menu", hidden: true });
    const toggle = el("button", {
      type: "button", class: "btn tiny tertiary menu-toggle", "aria-haspopup": "true", "aria-expanded": "false",
      "aria-label": `More actions for ${src.name}`,
      onclick: (e) => {
        e.stopPropagation();
        if (!list.childElementCount) {
          list.append(el("button", { class: "menu-item", role: "menuitem",
            onclick: () => copy(`${state.site.lat}, ${state.site.lon}`, "Lat/Lon copied") }, "Copy lat/long"));
          if (src.web_search) {
            const q = encodeURIComponent(fillTemplate(src.web_search));
            list.append(el("a", { class: "menu-item", role: "menuitem", href: `https://www.google.com/search?q=${q}`, target: "_blank", rel: "noopener" }, "Web search ↗"));
          }
          list.append(el("button", { class: "menu-item", role: "menuitem",
            onclick: () => showReportSection(targetSectionOf(src)) }, "Show in the report"));
          if (o.handoff) list.append(el("button", { class: "menu-item", role: "menuitem",
            onclick: () => focusHandoffTo(o.handoff) }, "Open the full card in the workbench ↗"));
          // Destructive, and no undo — ruled off and coloured as such (.danger).
          list.append(el("button", { class: "menu-item danger", role: "menuitem",
            onclick: () => clearNote(src.id, note) }, "Clear my note"));
          list.addEventListener("click", () => setCardMenuOpen(toggle, list, false));
          wireMenuKeys(toggle, list, (open) => setCardMenuOpen(toggle, list, open));
        }
        setCardMenuOpen(toggle, list, list.hidden);
        if (!list.hidden) focusFirstMenuItem(list);
      },
    }, "⋯");
    return el("div", { class: "menu card-menu" }, toggle, list);
  }

  function setCardMenuOpen(toggle, list, open) {
    if (open) closeCardMenus();
    list.hidden = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  // Keyboard behaviour shared by both overflow menus (the report toolbar's
  // "More ▾" and every card's ⋯): ↑/↓ walk the items, Home/End jump the ends,
  // and Esc closes and puts focus back on the trigger it came from — a menu that
  // strands focus on a detached node is worse than no menu.
  function focusFirstMenuItem(list) {
    const first = list.querySelector(".menu-item");
    if (first) first.focus();
  }
  // `sel` names the item class, so the same keys serve both overflow menus and
  // Focus mode's step list (.fx-list-item) — one implementation of ↑/↓/Home/End/Esc
  // rather than a second one that drifts from it.
  function wireMenuKeys(toggle, list, setOpen, sel) {
    list.addEventListener("keydown", (e) => {
      const items = [...list.querySelectorAll(sel || ".menu-item")];
      if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        items[(i + step + items.length) % items.length].focus();
      } else if (e.key === "Home") { e.preventDefault(); items[0].focus(); }
      else if (e.key === "End") { e.preventDefault(); items[items.length - 1].focus(); }
      else if (e.key === "Escape" || e.key === "Tab") {
        // Esc closes deliberately; Tab closes because focus is leaving anyway —
        // only Esc hands focus back, so tabbing on still moves forward.
        const wasOn = document.activeElement;
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); }
        setOpen(false);
        // Closing can REBUILD the surface this menu lives on — Focus mode's step
        // list closes by re-rendering the whole step shell — which detaches both
        // the item that had focus and the trigger remembered in this closure.
        // Focusing a detached node drops focus on <body>: Esc would land nowhere,
        // and Tab would resume from the top of the page instead of from here. Ids
        // survive a rebuild where nodes do not, so the trigger is looked up again.
        const live = document.contains(toggle) ? toggle
          : (toggle.id ? document.getElementById(toggle.id) : null);
        // Esc always goes back to the trigger. Tab only needs it when the close
        // pulled the ground out from under focus — the overflow menus do not
        // rebuild, so Tab there behaves exactly as it always has.
        if (live && (e.key === "Escape" || !document.contains(wasOn))) live.focus();
      }
    });
    toggle.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" && list.hidden) { e.preventDefault(); toggle.click(); }
    });
  }
  // One delegated pair of listeners for every card menu ever rendered — cards are
  // re-rendered constantly (every status tick rebuilds one), and per-card document
  // listeners would pile up against detached nodes.
  function closeCardMenus() {
    $$(".card-menu .menu-list:not([hidden])").forEach((list) => {
      list.hidden = true;
      const t = list.parentElement.querySelector(".menu-toggle");
      if (t) t.setAttribute("aria-expanded", "false");
    });
  }

  // Evidence photos: a button for the note's label row, and the body that goes
  // under the note (any thumbnails, plus the drop zone once it's asked for).
  // Empty, this costs one compact button rather than a 44 px dashed invitation on
  // every biosecurity card; pressing it reveals the real drop/paste/pick zone (and
  // the Wikipedia reference-image tools) and focuses it, so click-then-Ctrl+V
  // still lands a screenshot on the card.
  function renderPhotoBlock(src, f) {
    const body = el("div", { class: "src-photos" });
    const grid = el("div", { class: "photo-grid small" });
    f.images.forEach((im) => grid.append(renderPhotoThumb(im, () => removeFindingImage(src.id, im.id), (v) => { im.caption = v; saveImages(); })));
    const tools = el("div", { class: "photo-tools", id: `photos-${src.id}`, hidden: true });
    const addBtn = el("button", {
      type: "button", class: "btn tiny photo-add", "aria-expanded": "false", "aria-controls": tools.id,
      onclick: () => setPhotoTools(src, addBtn, tools, tools.hidden, true),
    }, "＋ Add photo");
    body.append(grid, tools);
    // Adding a photo re-renders the card; the zone stays open (and unfocused, so
    // the page doesn't jump) so a second paste doesn't need re-opening it.
    if (CARD_OPEN.photos.has(src.id)) setPhotoTools(src, addBtn, tools, true, false);
    return { addBtn, body };
  }

  function setPhotoTools(src, btn, tools, open, focus) {
    if (open && !tools.childElementCount) {
      const input = el("input", { type: "file", accept: "image/*", multiple: true, hidden: true });
      // Two labels, one button. Drag, drop and Ctrl+V do not exist on a phone, so
      // below 620px the stylesheet drops the paste prose and promotes this to a
      // full-width thumb target — the pick control is the only one that works on
      // every device, and it is never the small print. (Same reasoning, and the
      // same classes, as the station-photo zone in index.html.)
      const pickBtn = el("button", { type: "button", class: "pick-btn" },
        el("span", { class: "dz-paste" }, "choose a file"),
        el("span", { class: "dz-pick" }, "📷 Take or choose a photo"));
      // id: a photo landing re-renders the card (or, in Focus, the whole step), and
      // the zone is where the keyboard was — an id is what lets it be handed back.
      const zone = el("div", { class: "dropzone small", id: `drop-${src.id}`, tabindex: "0",
        "aria-label": "Add evidence photo — paste, drag and drop, or choose a file" },
        el("span", { class: "dz-paste" }, "📷 Drag & drop, paste, or "), pickBtn);
      wireDropzone(zone, input, (files) => addFindingImages(src.id, files));
      tools.append(zone, input);
      if (WIKI_IMAGE_CATEGORIES.has(src.category)) tools.append(renderWikiImageRow(src));
    }
    tools.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    CARD_OPEN.photos[open ? "add" : "delete"](src.id);
    // Focus lands on the zone so the click-then-Ctrl+V gesture the zone advertises
    // works without a second click.
    if (open && focus) { const z = tools.querySelector(".dropzone"); if (z) z.focus(); }
  }

  // Reference-image tools for species/subject cards. To keep the card to a single
  // text field at rest (the Notes textarea), the manual "type a name" search is
  // collapsed behind a button — most of the time the "from notes" auto-fetch is
  // all that's needed. Both attach a labelled, attributed Wikipedia photo.
  function renderWikiImageRow(src) {
    const listId = `weeds-${src.id}`;
    const useList = src.category === "invasive_plants" && DATA.weeds.length;
    const inp = el("input", {
      type: "text", class: "wiki-term", autocomplete: "off", spellcheck: "false",
      placeholder: WIKI_PLACEHOLDER[src.category] || "Species or subject name…",
      list: useList ? listId : null,
      "aria-label": "Fetch a reference image from Wikipedia by name",
    });
    const fetchBtn = el("button", { type: "button", class: "btn tiny secondary", onclick: () => fetchWikiImage(src.id, inp, fetchBtn) }, "Fetch");
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); fetchWikiImage(src.id, inp, fetchBtn); } });
    const searchRow = el("div", { class: "wiki-row collapsed" },
      el("span", { class: "wiki-lead" }, "From Wikipedia:"), inp, fetchBtn);
    if (useList) {
      const dl = el("datalist", { id: listId });
      DATA.weeds.forEach((w) => dl.append(el("option", { value: w })));
      searchRow.append(dl);
    }
    // Auto-fetch: scan this card's notes for species/subjects and fetch a photo for
    // each (also runs on note blur when the global "Auto-fetch" preference is on).
    const autoBtn = el("button", { type: "button", class: "btn tiny tertiary",
      title: "Scan this card's notes and fetch a labelled Wikipedia photo for every species/subject detected",
      onclick: () => autoFetchFromNotes(src.id, autoBtn) }, "Reference image from notes");
    // Reveal the manual search field on demand — keeps the resting card uncluttered.
    const searchToggle = el("button", { type: "button", class: "btn tiny tertiary",
      title: "Search Wikipedia for a reference image by typing a species/subject name",
      onclick: () => { const collapsed = searchRow.classList.toggle("collapsed"); if (!collapsed) inp.focus(); } }, "Search by name…");
    const tools = el("div", { class: "wiki-tools" }, autoBtn, searchToggle);
    return el("div", {}, tools, searchRow);
  }

  async function fetchWikiImage(sourceId, inp, btn) {
    const term = inp.value.trim();
    if (!term) { toast("Type a name first"); inp.focus(); return; }
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = `<span class="spin"></span> Fetching…`;
    try {
      await addWikiImage(sourceId, term); // rebuilds the card on success, detaching btn
    } catch (err) {
      toast(err.message || "Could not fetch an image");
    } finally {
      if (btn.isConnected) { btn.disabled = false; btn.innerHTML = orig; }
    }
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
    renderCollectionStatus();
    renderReport(); // evidence + suggested choices may change
  }

  // Tracks the operator's own "I've reviewed this card" progress — independent
  // of the Found/None/Failed/Manual result, which is about the source, not the human.
  function setReviewed(id, reviewed) {
    const f = state.findings[id] || (state.findings[id] = { status: STATUS.UNSET, note: "", result: null, images: [] });
    f.reviewed = !!reviewed;
    save();
    // Signing off can move the card out of (or into) the filtered view, so those
    // filters need the whole list rebuilt rather than the one card.
    if (state.filter === "signed" || state.filter === "attention") renderDashboard();
    else { refreshCard(id); renderCollectionStatus(); }
  }

  // Rebuilds one card in place. It re-derives density rather than assuming full,
  // so the very act of answering a card (or ticking it reviewed) settles it — and
  // when that changes the density under a keyboard user, focus is handed to the
  // card's new primary control instead of being dropped on the floor.
  function refreshCard(id) {
    // Focus mode has no card to refresh — the step IS the card. Every mutation in
    // the app (a status tick, a photo, an API result, an import, an agent write)
    // already calls through here, so this one branch is what makes both modes
    // repaint from the same call sites. `focus: false` because none of those
    // mutations is a navigation: it must not yank the caret out of the note.
    if (focusLive()) { renderFocus({ focus: false }); return; }
    const src = DATA.sources.find((s) => s.id === id);
    const old = $(`#src-${id}`);
    if (!old || !src) return;
    const hadFocus = old.contains(document.activeElement);
    const was = old.dataset.density;
    const node = renderSourceCard(src);
    old.replaceWith(node);
    if (hadFocus && node.dataset.density !== was) {
      const first = node.querySelector(".src-line, .src-expand, .src-collapse, button, input, select, textarea, a");
      if (first) first.focus();
    }
  }

  // Clear the notes text for a card (photos + reference images are kept). Handy for
  // wiping agentic entries and redoing a card's notes from scratch. Confirmed
  // because there's no undo and the text may be substantial.
  function clearNote(id, textarea) {
    const f = state.findings[id];
    if (!f || !(f.note && f.note.trim())) { toast("No notes to clear on this card."); return; }
    if (!confirm("Clear your note on this card?\n\nPhotos and reference images are kept. This can't be undone.")) return;
    f.note = "";
    if (textarea) { textarea.value = ""; autoGrow(textarea); }
    save();
    renderReport(); // the cleared note drops out of its report section live
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
    // Both may be absent: "Run auto-checks" works the whole source list, including
    // cards a dashboard filter is currently hiding.
    const btn = $(`#run-${src.id}`);
    const res = $(`#res-${src.id}`);
    const s = state.site;
    const radius = (src.api && src.api.radius_km) || 10;
    if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spin"></span> Checking…`; }
    paintResult(res, "Querying Atlas of Living Australia…", { label: "Checking" });
    try {
      const r = await alaQuery(s.lat, s.lon, radius, src.api && src.api.endpoint);
      const f = state.findings[src.id] || (state.findings[src.id] = {});
      f.status = r.status; f.result = { html: r.html, ts: Date.now() };
      save(); refreshCard(src.id); renderCollectionStatus(); renderReport();
      maybeAutoFetchForSource(src.id); // reference photos for any listed taxa (Task 3)
    } catch (err) {
      const f = state.findings[src.id] || (state.findings[src.id] = {});
      f.status = STATUS.FAILED;
      f.result = { html: `Could not reach the Atlas of Living Australia API (${esc(err.message)}). This is usually a network or browser CORS restriction. Use the <b>Open ↗</b> link to check manually, then set the result.`, err: true, ts: Date.now() };
      save(); refreshCard(src.id);
      renderCollectionStatus(); renderReport();
    }
  }

  // ---------------------------------------------------------------- WildNet check
  // Query the Queensland WildNet Data API (public, no key) for the conservation-
  // significant taxa near the point, and GROUP them by kingdom so a threatened
  // plant is presented as flora, never as fauna. Mirrors alaQuery's shape (status
  // + HTML + text). Endpoint/paths come from the source's api block.
  //   GET {base}/api/v1/species-list?central_point_latitude=..&central_point_longitude=..&distance=..&con_sig=1&page_size=5000
  // Each row: kingdom_name (Plantae/Animalia), scientific_name, accepted_common_name,
  // nca_code (QLD Nature Conservation Act status), epbc_code (national status).
  async function wildnetQuery(lat, lon, radius, api) {
    const base = (api && api.base_url) || "https://wildnet-pub.science-data.qld.gov.au";
    const listPath = (api && api.species_list_path) || "/api/v1/species-list";
    const geo = `central_point_latitude=${lat}&central_point_longitude=${lon}&distance=${radius}`;
    const rows = await fetchJson(`${base}${listPath}?${geo}&con_sig=1&page_size=5000`);
    const list = Array.isArray(rows) ? rows : [];
    const groups = { flora: [], fauna: [], other: [] };
    list.forEach((r) => {
      const kn = (r[(api && api.kingdom_field) || "kingdom_name"] || "").toLowerCase();
      groups[kn === "plantae" ? "flora" : kn === "animalia" ? "fauna" : "other"].push(r);
    });
    const total = list.length;
    if (!total) {
      return { status: STATUS.NONE,
        html: `<b>No conservation-significant species</b> in Queensland WildNet within ${radius} km. Source: Queensland WildNet species register.`,
        text: `No conservation-significant WildNet species within ${radius} km.` };
    }
    const statusOf = (r) => [r.nca_code && `NCA ${r.nca_code}`, r.epbc_code && `EPBC ${r.epbc_code}`].filter(Boolean).join(", ");
    const name = (r) => {
      const sci = r.scientific_name || "", com = r.accepted_common_name || "";
      const base = sci || com || "unnamed taxon";
      const label = sci && com ? `${sci} (${com})` : base;
      const st = statusOf(r);
      return st ? `${label} — ${st}` : label;
    };
    const CAP = 40;
    const secHtml = (label, arr) => arr.length
      ? `<div style="margin-top:6px"><b>${label} (${arr.length})</b><ul class="r-species">${arr.slice(0, CAP).map((r) => `<li>${esc(name(r))}</li>`).join("")}${arr.length > CAP ? `<li>…and ${arr.length - CAP} more</li>` : ""}</ul></div>`
      : "";
    const secText = (label, arr) => arr.length ? ` ${label} (${arr.length}): ${arr.slice(0, CAP).map(name).join("; ")}.` : "";
    const html = `<b>${total} conservation-significant taxa</b> in Queensland WildNet within ${radius} km.` +
      secHtml("Flora — plants", groups.flora) + secHtml("Fauna — animals", groups.fauna) + secHtml("Other (fungi, etc.)", groups.other) +
      `<div style="margin-top:6px;opacity:.7">Source: Queensland WildNet species register. File each taxon under the matching section (plants → Threatened Flora, animals → Threatened Fauna).</div>`;
    const text = `${total} conservation-significant WildNet taxa within ${radius} km.` +
      secText("Flora", groups.flora) + secText("Fauna", groups.fauna) + secText("Other", groups.other);
    return { status: STATUS.FOUND, html, text };
  }

  async function runWildnet(src) {
    const btn = $(`#run-${src.id}`);
    const res = $(`#res-${src.id}`);
    const s = state.site;
    const radius = (src.api && src.api.radius_km) || 10;
    if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spin"></span> Checking…`; }
    paintResult(res, "Querying Queensland WildNet…", { label: "Checking" });
    try {
      const r = await wildnetQuery(s.lat, s.lon, radius, src.api);
      const f = state.findings[src.id] || (state.findings[src.id] = {});
      f.status = r.status; f.result = { html: r.html, ts: Date.now() };
      save(); refreshCard(src.id); renderCollectionStatus(); renderReport();
      maybeAutoFetchForSource(src.id);
    } catch (err) {
      const f = state.findings[src.id] || (state.findings[src.id] = {});
      f.status = STATUS.FAILED;
      f.result = { html: `Could not reach the Queensland WildNet API (${esc(err.message)}). This is usually a network or browser CORS restriction. Use the <b>Open ↗</b> link to run the search in the WildNet app, then set the result.`, err: true, ts: Date.now() };
      save(); refreshCard(src.id);
      renderCollectionStatus(); renderReport();
    }
  }

  async function fetchJson(url) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // Which live-check runner (if any) handles a source's API kind.
  function apiRunnerFor(src) {
    if (src.method !== "api" || !src.api) return null;
    if (src.api.kind === "ala_biocache") return runAla;
    if (src.api.kind === "wildnet") return runWildnet;
    return null;
  }

  // Step 3A. Runs every source with a live data API and reports the outcome next to
  // the button — the operator needs to know how much of the list this actually
  // answered before they move on to the prompt.
  async function runAllAuto(e) {
    const btn = (e && e.currentTarget) || $("#btn-run-auto");
    const list = sourcesForSite().filter(apiRunnerFor);
    if (!list.length) {
      // Nothing to run here, so the sequence moves on rather than leaving a filled
      // button pointing at a step this site can never complete.
      setFlowStatus("#auto-status", "No live-data sources apply to this site — go straight to the prompt below.", "warn");
      markFlowDone("auto", "No live-data sources apply to this site");
      return;
    }
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Checking…'; }
    let done = 0;
    setFlowStatus("#auto-status", `Checking ${list.length} live source${list.length > 1 ? "s" : ""}…`);
    for (const src of list) {
      // Each runner records its own result (and its own failure) into state, so a
      // source that throws must not stop the ones after it.
      try { await apiRunnerFor(src)(src); } catch (_) {}
      setFlowStatus("#auto-status", `Checked ${++done} of ${list.length}…`);
    }
    if (btn) { btn.disabled = false; btn.innerHTML = "Run auto-checks"; }
    const tally = { found: 0, none: 0, failed: 0, manual: 0, unset: 0 };
    list.forEach((s) => tally[(state.findings[s.id] || {}).status || "unset"]++);
    const bits = [];
    if (tally.found) bits.push(`${tally.found} found`);
    if (tally.none) bits.push(`${tally.none} nothing found`);
    if (tally.failed) bits.push(`${tally.failed} couldn't be reached`);
    const summary = `${list.length} live source${list.length > 1 ? "s" : ""} checked${bits.length ? " — " + bits.join(", ") : ""}`;
    setFlowStatus("#auto-status", `✓ ${summary}.`, tally.failed ? "warn" : "ok");
    markFlowDone("auto", summary);
  }

  // ------------------------------------------------------ step 3 (run the checks)
  // Debounced "does this look right yet" check on the paste box. Held at this
  // scope so applying (or switching site) can cancel a pending one — otherwise it
  // lands a moment later against the now-empty box and wipes the confirmation
  // that was just written there.
  let pastePreviewTimer = null;

  // The three sub-steps of step 3 each report next to their own button. `tone` is
  // "" (working), "ok", "warn" or "err".
  function setFlowStatus(sel, msg, tone) {
    const n = $(sel);
    if (!n) return;
    n.textContent = msg || "";
    n.className = "flow-status" + (tone ? " is-" + tone : "");
  }

  // Step 3 is a sequence, so exactly one of its three sub-steps carries a filled
  // button: the next one that hasn't been run. The ones behind it swap their letter
  // for a ✓ and fold to a one-line receipt of what they did — quiet, but never
  // disabled, because re-running the auto-checks or re-copying the prompt is
  // entirely legitimate, and the receipt's own button does exactly that.
  const FLOW_STEPS = [
    { key: "auto", btn: "#btn-run-auto", receipt: "#auto-receipt", done: "Auto-checks run" },
    { key: "prompt", btn: "#btn-copy-prompt", receipt: "#prompt-receipt", done: "Prompt copied" },
    { key: "applied", btn: "#btn-paste-apply", receipt: "#applied-receipt", done: "Response applied" },
  ];
  // `notes` carries each sub-step's receipt line ("12 sources answered") so the
  // folded card still says what the run actually did, on this site, after a reload.
  function freshFlow() { return { auto: false, prompt: false, applied: false, notes: {} }; }
  function normalizeFlow(saved) {
    const f = freshFlow();
    if (!saved || typeof saved !== "object") return f;
    FLOW_STEPS.forEach(({ key }) => {
      f[key] = !!saved[key];
      const note = saved.notes && saved.notes[key];
      if (typeof note === "string") f.notes[key] = note.slice(0, 140);
    });
    return f;
  }
  // A sub-step that has been run records what it did. Re-running refreshes the
  // receipt, so `done` is not a latch that ignores the second run.
  function markFlowDone(step, receipt) {
    if (!state.flow) state.flow = freshFlow();
    state.flow[step] = true;
    if (receipt) state.flow.notes[step] = String(receipt).slice(0, 140);
    save();
    syncFlowSteps();
  }

  // Which done sub-steps the operator has explicitly re-opened. Session-only and
  // per site (resetRunChecks clears it): a receipt folds back down on the next
  // site rather than carrying one site's open state onto another.
  let flowOpen = {};
  // Whether the finished card is expanded. Same lifetime as flowOpen.
  let runChecksOpen = false;
  function openFlowStep(key) {
    flowOpen[key] = true;
    runChecksOpen = true; // a sub-step can't show through a folded card
    syncFlowSteps();
  }
  function setRunChecksOpen(open) {
    runChecksOpen = !!open;
    syncFlowSteps();
  }

  function syncFlowSteps() {
    const flow = state.flow || (state.flow = freshFlow());
    const next = FLOW_STEPS.find(({ key }) => !flow[key]);
    FLOW_STEPS.forEach(({ key, btn: sel, receipt, done }) => {
      const isDone = !!flow[key];
      const step = $(`.flow-step[data-flow="${key}"]`);
      if (step) {
        step.classList.toggle("is-done", isDone);
        // Done and not re-opened → the step is its receipt line and nothing else.
        step.classList.toggle("is-folded", isDone && !flowOpen[key]);
      }
      const rec = $(receipt);
      if (rec) rec.textContent = "✓ " + (flow.notes[key] || done);
      const btn = $(sel);
      if (!btn) return;
      const lead = !!next && next.key === key;
      btn.classList.toggle("primary", lead);
      btn.classList.toggle("secondary", !lead);
    });

    // All three passes done: the card itself stands down to one line — the step
    // heading, what the run produced, and Re-open.
    const complete = FLOW_STEPS.every(({ key }) => flow[key]);
    const card = $("#run-checks");
    const body = $("#run-checks-body");
    const toggle = $("#btn-run-checks-toggle");
    const rcReceipt = $("#rc-receipt");
    const folded = complete && !runChecksOpen;
    if (card) {
      card.classList.toggle("is-complete", complete);
      card.classList.toggle("is-folded", folded);
    }
    if (body) body.hidden = folded;
    if (toggle) {
      toggle.hidden = !complete;
      toggle.textContent = folded ? "Re-open" : "Hide";
      toggle.setAttribute("aria-expanded", folded ? "false" : "true");
      toggle.title = folded ? "Show the three passes again" : "Fold the finished checks back to one line";
    }
    if (rcReceipt) {
      // The two passes that produce a number are the ones worth carrying up here;
      // "Prompt copied" adds nothing the other two don't already imply.
      const bits = ["auto", "applied"].map((k) => flow.notes[k]).filter(Boolean);
      const text = complete ? "✓ " + (bits.length ? bits.join(" · ") : "All three passes done") : "";
      if (rcReceipt.textContent !== text) rcReceipt.textContent = text;
      rcReceipt.hidden = !folded;
    }
  }

  // Wipe step 3 back to its resting state — called whenever a different site is
  // loaded, so one site's confirmation can't be read as another's.
  function resetRunChecks() {
    clearTimeout(pastePreviewTimer);
    setFlowStatus("#auto-status", "");
    setFlowStatus("#prompt-status", "");
    setFlowStatus("#paste-status", "");
    const box = $("#paste-json");
    if (box) box.value = "";
    flowOpen = {};
    runChecksOpen = false;
  }

  // Assistants wrap their JSON in code fences, or top and tail it with prose. Dig
  // the object out rather than making the operator tidy the reply up by hand.
  function extractJsonPayload(raw) {
    let text = String(raw == null ? "" : raw).trim();
    if (!text) return null;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) text = fenced[1].trim();
    try { return JSON.parse(text); } catch (_) {}
    // Last resort: the outermost {...} in whatever was pasted.
    const open = text.indexOf("{"), close = text.lastIndexOf("}");
    if (open >= 0 && close > open) { try { return JSON.parse(text.slice(open, close + 1)); } catch (_) {} }
    return null;
  }

  // Single entry point for every path that brings findings in (the step-3 paste
  // box, the Advanced file import): a batch envelope opens the batch tray, a
  // single findings object loads straight into the workspace.
  function routeImport(json) {
    if (json && Array.isArray(json.sites)) { importBatch(json); return "batch"; }
    importFindings(json);
    return "site";
  }

  // How many sources the pasted reply actually answered — the one number that says
  // whether the round trip worked.
  function answeredCount(json) {
    const log = (json && json.collection_log) || [];
    return log.filter((c) => c && c.status && c.status !== STATUS.UNSET).length;
  }

  function applyPastedJson() {
    clearTimeout(pastePreviewTimer);
    const box = $("#paste-json");
    const raw = box ? box.value : "";
    if (!raw.trim()) { setFlowStatus("#paste-status", "Paste the assistant's reply into the box first.", "warn"); return; }
    const json = extractJsonPayload(raw);
    if (!json) {
      setFlowStatus("#paste-status", "That isn't JSON. Copy the assistant's reply again — it ends with one JSON object.", "err");
      return;
    }
    const answered = answeredCount(json);
    try {
      const kind = routeImport(json);
      if (box) box.value = "";
      setFlowStatus("#paste-status", kind === "batch"
        ? "✓ Batch loaded — pick a site from the tray above."
        : `✓ Response applied${answered ? ` — ${answered} source${answered > 1 ? "s" : ""} answered` : ""}. Anything left over is in step 4 below.`, "ok");
      markFlowDone("applied", answered ? `${answered} source${answered > 1 ? "s" : ""} answered` : "Response applied");
      if (kind !== "site") return;
      // Applying a reply answers a large part of the list in one action and
      // reshapes everything downstream of it. Both modes therefore land on what is
      // LEFT rather than on the top of the thing that just changed — the workbench
      // on its dashboard, Focus on the first source step that still needs a human
      // (not the first source step in the list, which the reply has usually already
      // answered), carrying one sentence saying what the round trip did.
      if (focusLive()) focusAfterApply(answered);
      else requestAnimationFrame(() => jumpTo($("#dashboard")));
    } catch (err) {
      setFlowStatus("#paste-status", "Couldn't apply that: " + err.message, "err");
    }
  }

  // Cheap "does this look right yet" feedback while the box has something in it,
  // so a half-copied reply is obvious before Apply is pressed.
  function previewPastedJson() {
    const box = $("#paste-json");
    if (!box) return;
    if (!box.value.trim()) { setFlowStatus("#paste-status", ""); return; }
    const json = extractJsonPayload(box.value);
    if (!json) { setFlowStatus("#paste-status", "Not valid JSON yet.", "warn"); return; }
    if (Array.isArray(json.sites)) { setFlowStatus("#paste-status", `Batch of ${json.sites.length} sites — press Apply.`, "ok"); return; }
    if (!isFindingsObject(json)) { setFlowStatus("#paste-status", "Valid JSON, but not an ESS findings object (needs `site` and `collection_log`).", "warn"); return; }
    const answered = answeredCount(json);
    setFlowStatus("#paste-status", `Findings for ${json.site.name || "this site"} — ${answered} source${answered === 1 ? "" : "s"} answered. Press Apply.`, "ok");
  }

  // ------------------------------------------------------- collection status
  // The one control that answers "what still needs me". A journey, not a
  // scoreboard: two segments (answered / still needing you) rather than six legend
  // pills, the count in words, and the four filter segments underneath — which ARE
  // the filter, so there is no separate "Show only" row and no banner repeating the
  // same number in different words. Per-result counts live one click away, behind
  // "Results", for the rare moment they matter.
  function statusCounts() {
    const list = sourcesForSite().map((s) => state.findings[s.id] || {});
    const byStatus = { found: 0, none: 0, failed: 0, manual: 0, unset: 0 };
    list.forEach((f) => { byStatus[statusOf(f)]++; });
    const outstanding = list.filter(isOutstanding).length;
    return { list, n: list.length, byStatus, outstanding, answered: list.length - outstanding,
      signed: list.filter(isSignedOff).length };
  }

  function outstandingSentence(c) {
    if (!c.n) return "No sources apply to this site.";
    if (!c.outstanding) return c.signed >= c.n
      ? `All ${c.n} sources answered and signed off.`
      : `All ${c.n} answered — ${c.n - c.signed} still to sign off.`;
    return `${c.outstanding} of ${c.n} still need you`;
  }

  function renderCollectionStatus() {
    const bar = $("#collection-status");
    if (!bar || !state.site) return;
    const c = statusCounts();
    const fill = $("#cs-fill");
    if (fill) fill.style.width = c.n ? `${Math.round((c.answered / c.n) * 100)}%` : "0";
    bar.classList.toggle("is-clear", c.n > 0 && !c.outstanding);
    // Nothing left outstanding is one of the two ways a site counts as finished
    // (the other is exporting it) — after that the guide is on demand only.
    if (c.n > 0 && !c.outstanding) markOnboarded();

    // role="status" — only write when the sentence actually changed, so a screen
    // reader announces the outstanding count on the ticks that move it and stays
    // quiet through the renders that don't.
    const count = $("#cs-count");
    const text = outstandingSentence(c);
    if (count && count.textContent !== text) count.textContent = text;

    const segs = $("#cs-segs");
    if (segs) {
      segs.replaceChildren(...Object.entries(FILTERS).filter(([, def]) => def.seg).map(([key, def]) => {
        const on = state.filter === key;
        return el("button", {
          type: "button", class: "cs-seg" + (on ? " on" : ""), "data-seg": key,
          "aria-pressed": on ? "true" : "false",
          title: SEG_HINT[key],
          onclick: () => setFilter(on && key !== "all" ? "all" : key),
        }, el("span", {}, def.label), el("b", {}, `${def.count(c.list)}`));
      }));
    }
    syncSortToggle();
    // The Results panel is where a per-result filter lives, so it is never shut
    // while one is on — otherwise the list would be narrowed by a control that
    // isn't on screen, which is the "mystery filter" the old bar could produce.
    if (!activeFilter().seg) setStatusDetailOpen(true);
    else if (!$("#cs-detail").hidden) renderStatusDetail();
    refreshRailBadges(); // same definition of "outstanding", shown per category on the rail
    refreshMobileNav();  // …on the Collect tab and its chips, below 981px
    refreshGroupHeads(); // …and per category on each group's roll-up
    renderStarvedSections(); // …and which report sections are still empty, from over here
    // …and Focus mode's step list, which counts the same things. Every path that
    // changes a result already comes through here, so this is the one hook the
    // derived step graph needs to stay live.
    if (focusLive()) renderFocus({ focus: false });
    // The sentence just changed width/wrap, and this card is what the sticky group
    // headers pin under (covers browsers without ResizeObserver too).
    measureStatusBar();
  }

  // Report sections this site's sources could fill, but nothing has been included
  // into yet. A section is only "in play" when at least one source that applies
  // here belongs to one of its categories — otherwise a site with no permits
  // sources would be told forever that Permits and permissions is empty.
  function starvedSections() {
    if (!state.site || !REPORT_SECTIONS.length) return [];
    const cats = new Set(sourcesForSite().filter((s) => !s.internal).map((s) => s.category));
    return REPORT_SECTIONS.filter((sec) =>
      (sec.cats || []).some((c) => cats.has(c)) && !includedCardsForSection(sec.id).length);
  }

  // …shown from the collection pane, because that is where the evidence comes
  // from. Before this, an empty section could only be discovered by scrolling the
  // report. Names are buttons, so the row is also the way to each one.
  const STARVED_NAMED = 4; // beyond this, the row states the count and stops listing
  function renderStarvedSections() {
    const row = $("#cs-starved");
    if (!row) return;
    const starved = starvedSections();
    row.hidden = !starved.length;
    if (!starved.length) { row.replaceChildren(); return; }
    const kids = [el("span", { class: "cs-starved-lead" },
      el("span", { class: "cs-starved-mark", "aria-hidden": "true" }, "○"),
      `${starved.length} report section${starved.length === 1 ? "" : "s"} with no evidence`)];
    starved.slice(0, STARVED_NAMED).forEach((sec, i) => {
      if (i) kids.push(el("span", { class: "r-ev-sep", "aria-hidden": "true" }, "·"));
      kids.push(el("button", { type: "button", class: "cs-starved-sec",
        "aria-label": `${sec.title} has no evidence yet — show it in the report`,
        onclick: () => showReportSection(sec.id) }, sec.title));
    });
    if (starved.length > STARVED_NAMED)
      kids.push(el("span", { class: "cs-starved-rest" }, `+${starved.length - STARVED_NAMED} more`));
    row.replaceChildren(...kids);
  }

  const SEG_HINT = {
    attention: "Manual, Search failed and Not checked — the sources a human still owns",
    answered: "Found and Nothing found — the sources that have an answer",
    signed: "Sources you have signed off",
    all: "Every source that applies to this site",
  };

  // The per-result breakdown, behind the bar's "Results" disclosure: the detail
  // that used to be six permanent legend pills plus a six-button filter row. Each
  // count is also the filter for that result, so nothing was lost by folding it away.
  function renderStatusDetail() {
    const panel = $("#cs-detail");
    if (!panel) return;
    const c = statusCounts();
    panel.replaceChildren(...["found", "none", "failed", "manual", "unset"].map((s) => {
      const on = state.filter === s;
      return el("button", {
        type: "button", class: `cs-res ${s}` + (on ? " on" : ""), "aria-pressed": on ? "true" : "false",
        title: `Show only sources marked ${FILTERS[s].label}`,
        onclick: () => setFilter(on ? "all" : s),
      }, statusDot(s), el("span", {}, FILTERS[s].label), el("b", {}, `${c.byStatus[s]}`));
    }));
  }

  function setStatusDetailOpen(open) {
    const panel = $("#cs-detail"), btn = $("#cs-more");
    if (!panel || !btn) return;
    if (open) renderStatusDetail();
    panel.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.classList.toggle("on", open);
    btn.title = open ? "Hide the per-result counts" : "Per-result counts — and filter by one result";
    measureStatusBar();
  }

  // Putting the panel away also puts away the filter that lives in it, so the list
  // can never be narrowed by a control that isn't on screen. setFilter re-renders,
  // which is what actually closes the panel in that case.
  function toggleStatusDetail() {
    const open = $("#cs-detail").hidden;
    if (!open && !activeFilter().seg) { setFilter("all"); setStatusDetailOpen(false); return; }
    setStatusDetailOpen(open);
  }

  // The dashboard's only filter setter. Persisted per site (see saveNow/restore),
  // so coming back to a site keeps your place instead of resetting to everything.
  function setFilter(key) {
    if (!FILTERS[key]) key = "all";
    if (state.filter === key) return;
    state.filter = key;
    // A discrete choice, and often the last thing done before a reload — persist it
    // now rather than 400 ms later. (flushSave alone is a no-op with nothing queued.)
    save(); flushSave();
    renderDashboard(); // re-renders the bar (and its segments) on the way through
  }

  // Ordering, not filtering — one toggle rather than two buttons in the filter run.
  function syncSortToggle() {
    const btn = $("#cs-sort");
    if (!btn) return;
    const attentionFirst = state.cardSort === "attention";
    btn.replaceChildren(el("span", { "aria-hidden": "true" }, "⇅"),
      el("span", {}, attentionFirst ? "Attention first" : "Source order"));
    btn.title = attentionFirst
      ? "Ordered by what still needs you — click for the source registry's own order"
      : "Ordered as the source registry lists them — click to put what needs you first";
    btn.setAttribute("aria-label", `Card order: ${attentionFirst ? "attention first" : "source order"}. Click to change.`);
  }

  function setCardSort(mode) {
    if (state.cardSort === mode) return;
    state.cardSort = mode;
    try { localStorage.setItem(LS_CARD_SORT, mode); } catch (_) {}
    renderDashboard();
  }

  // ---------------------------------------------------------------- report
  // Report sections mirror the ESS proforma. The definition is the single
  // source of truth in data/sources.json (`report_sections`) so the browser
  // tool and the ess-collect skill stay in lockstep; populated on load.
  let REPORT_SECTIONS = [];

  // -------------------------------------------------- source → report-section link
  // Each source's notes + photos flow into exactly ONE report section — its
  // "target", with a smart default that the operator can override per card via the
  // Include control. This replaces the old implicit rule ("every source in a
  // category feeds every report section sharing that category"), which duplicated
  // the same photo across sibling sections — e.g. an animal photo appearing under
  // Threatened Habitat *and* Flora *and* Fauna at once.
  function defaultSectionForSource(src) {
    if (!src) return null;
    if (src.report_section) return src.report_section; // explicit per-source hint wins
    const secs = REPORT_SECTIONS.filter((s) => (s.cats || []).includes(src.category));
    if (!secs.length) return null;
    if (secs.length === 1) return secs[0].id;
    // Category maps to several sections — pick the best fit from the source name.
    const hay = `${src.id} ${src.name}`.toLowerCase();
    if (src.category === "threatened") {
      if (/ecosystem|wetland|\bhabitat\b|regional[- ]?ecosystem|vegetation|community|communities/.test(hay)) return "threatened_habitat";
      if (/flora|plant|plantnet|weed/.test(hay)) return "threatened_flora";
      if (/\bfauna\b|\banimal\b|\bbird\b|frog|fish/.test(hay)) return "threatened_fauna";
      // Broad biodiversity registers (PMST, Atlas of Living Australia, WildNet,
      // BioNet, state atlases) return BOTH plants and animals — never pre-file them
      // under Fauna, which is how a threatened plant used to land in the wrong
      // section. Default them to the umbrella Threatened Habitat section; the agent /
      // operator then classifies each taxon into Flora vs Fauna explicitly.
      return "threatened_habitat";
    }
    if (src.category === "indigenous_heritage") {
      return /heritage|inherit|achis|historic|register/.test(hay) ? "heritage" : "indigenous_areas";
    }
    return secs[0].id;
  }
  function targetSectionOf(src, f) {
    f = f || state.findings[src.id] || {};
    const t = f.targetSection;
    if (t && REPORT_SECTIONS.some((s) => s.id === t)) return t;
    return defaultSectionForSource(src);
  }
  // A card's content appears in the report when it's "included". Default (no
  // explicit choice yet): auto-include as soon as there's something to show (a
  // note or a photo), so existing/imported work still flows straight through.
  function cardIncluded(f) {
    if (f && typeof f.included === "boolean") return f.included;
    return !!(f && ((f.note && f.note.trim()) || (f.images && f.images.length)));
  }
  function includedCardsForSection(sectionId) {
    return sourcesForSite()
      .map((src) => ({ src, f: state.findings[src.id] || {} }))
      // Internal / login-only sources (e.g. the Bureau permits register, POPE /
      // leasing SharePoint) are operator working items: their notes are "how to
      // check internal system X" instructions for staff, not ESS content. They stay
      // visible on the collection dashboard but never flow into the report — on
      // screen or in any export — so those instructions can't land in the final report.
      .filter(({ src, f }) => !src.internal && cardIncluded(f) && targetSectionOf(src, f) === sectionId);
  }
  // Point a card at a report section (from its Include dropdown). Choosing a
  // target implies the user wants it in the report, so include it too.
  function setTargetSection(id, sectionId) {
    const f = state.findings[id] || (state.findings[id] = { status: STATUS.UNSET, note: "", result: null, images: [] });
    f.targetSection = sectionId;
    f.included = true;
    save(); refreshCard(id); renderReport();
  }
  // Cards showing the "added to …" receipt. Transient and deliberately not
  // persisted: it is feedback on an action just taken, not card state, so a
  // reload — or the next full dashboard render — clears it.
  const INCLUDE_FLASH = new Set();
  const INCLUDE_FLASH_MS = 6000;

  function toggleInclude(id) {
    const f = state.findings[id] || (state.findings[id] = { status: STATUS.UNSET, note: "", result: null, images: [] });
    const now = f.included = !cardIncluded(f);
    save();
    if (now) {
      INCLUDE_FLASH.add(id);
      setTimeout(() => {
        if (!INCLUDE_FLASH.delete(id)) return;
        // Focus carries the same receipt on its source step, and has no #src- card
        // to test for — refreshCard re-renders the step there instead.
        if (focusLive() || document.getElementById(`src-${id}`)) refreshCard(id);
      }, INCLUDE_FLASH_MS);
    } else {
      INCLUDE_FLASH.delete(id);
    }
    refreshCard(id); renderReport();
    // …and the destination lights up, so the effect is visible on both sides even
    // when the operator's eye stays on the card. Pure accent change, no motion.
    const src = DATA.sources.find((s) => s.id === id);
    if (now && src) flashSectionLink(targetSectionOf(src, f));
  }

  // Briefly wear the same accent the reciprocal highlight uses, so "it landed
  // there" is said in the vocabulary the operator already learned by hovering.
  function flashSectionLink(sectionId) {
    const node = sectionId && document.getElementById(`rsec-${sectionId}`);
    if (!node) return;
    node.classList.add("is-linked");
    setTimeout(() => { if (!LINKED.includes(node)) node.classList.remove("is-linked"); }, INCLUDE_FLASH_MS);
  }

  // -------------------------------------------------- cross-column "Show" jumps
  // The two columns scroll independently (desktop) or the page scrolls (narrow),
  // so scrollIntoView() targets the right scroll container automatically. A brief
  // highlight helps the eye land on whatever was jumped to.
  //
  // EVERY jump in the app goes through jumpTo(), because scrolling on its own is
  // only half of a jump. It moves the viewport and leaves the keyboard exactly
  // where it was, so the next Tab carries on from whatever the operator jumped
  // FROM — they have been moved visually but not logically, and for a screen
  // reader user nothing has happened at all. Moving focus to the landing section
  // makes the two agree: the heading is announced, the ring says where focus now
  // is, and Tab continues from there.
  function jumpTo(node, opts) {
    if (!node) return;
    const o = opts || {};
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    node.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: o.block || "start" });
    // Sections and group wrappers are not focusable on their own. -1 keeps them
    // out of the tab order while allowing focus(); preventScroll stops the focus
    // call fighting the smooth scroll that is still running.
    //
    // `focus: false` is for the scrolls that are a side effect of a re-render
    // rather than a jump the operator asked for — restoring a saved batch does one
    // on page load, and taking focus there would be a worse bug than the one this
    // whole function exists to fix.
    if (o.focus !== false) {
      if (!node.hasAttribute("tabindex")) node.setAttribute("tabindex", "-1");
      node.focus({ preventScroll: true });
    }
    if (o.flash) flashTarget(node);
  }

  function flashTarget(node) {
    if (!node) return;
    node.classList.remove("flash-target");
    void node.offsetWidth; // restart the animation if it's still running
    node.classList.add("flash-target");
    setTimeout(() => node.classList.remove("flash-target"), 1500);
  }
  // A card's destination link → scroll the report (right) to its target section.
  // Sending someone to a pane they have collapsed is a dead end, so the jump
  // opens it first.
  function showReportSection(sectionId) {
    // In Focus there is no report pane to scroll to — but the section has a step of
    // its own, carrying the same content and the same Reviewed tick, so "show me
    // that section" means going there rather than doing nothing.
    if (focusLive()) {
      focusGoTo(sectionId === IDENTITY_SECTION ? "out:identity" : `sec:${sectionId}`);
      return;
    }
    const node = document.getElementById(`rsec-${sectionId}`);
    if (!node) return;
    revealRightPane();
    jumpTo(node, { flash: true });
  }
  // A report evidence name → scroll the collection (left) to the source card. The
  // card may be hidden by the active dashboard filter, so drop back to "All" and
  // re-render first if it isn't currently on screen.
  function showSourceCard(sourceId) {
    // …and the same the other way: the source's own step is where it is shown.
    // (focusHandoffTo switches modes BEFORE calling this, so the handoff still
    // lands on the real card.)
    //
    // A jump made FROM a section step is an errand — the caveat strip saying three
    // of this section's sources were never checked is a prompt to go and check one
    // — so it arms the way back. Every route into a source from a section (an
    // evidence name, the caveat strip, the waiting list) runs through here, which
    // is why the arming lives here rather than at each of them.
    if (focusLive()) {
      focusGoTo(`src:${sourceId}`, null,
        { returnTo: focusCursor && focusCursor.startsWith("sec:") ? focusCursor : null });
      return;
    }
    revealLeftPane();
    let node = document.getElementById(`src-${sourceId}`);
    if (!node) {
      state.filter = "all";
      save();
      const internalToggle = $("#toggle-manual-internal");
      if (internalToggle && !internalToggle.checked) internalToggle.checked = true;
      renderDashboard();
      node = document.getElementById(`src-${sourceId}`);
    }
    if (!node) return;
    // The card may be inside a folded category, or settled down to one line. Being
    // sent here is a request to see it, so open whatever is in the way.
    const group = node.closest(".group");
    if (group && group.classList.contains("is-collapsed")) setGroupOpen(group, true, false);
    if (node.dataset.density !== "full") {
      CARD_OPEN.expanded.add(sourceId);
      refreshCard(sourceId);
      node = document.getElementById(`src-${sourceId}`);
    }
    jumpTo(node, { flash: true });
  }

  // ------------------------------------------------- reciprocal pane highlight
  // The split view's best structural idea — collect on the left, watch the report
  // build on the right — used to be joined only by a small repeated number and 43
  // buttons whose whole job was "find the other half of this". Hovering or
  // focusing either half now tints the other, which teaches the mapping without a
  // word of documentation and without moving anything on screen. Pure accent
  // change: nothing to suppress under prefers-reduced-motion.
  let LINKED = []; // nodes currently wearing .is-linked

  function clearLinkHighlight() {
    LINKED.forEach((n) => n.classList.remove("is-linked"));
    LINKED = [];
  }

  // What is the other half of whatever the pointer/focus is on? Collection card →
  // the one report section it feeds. Report section (or one of its evidence
  // entries) → every card feeding it.
  function linkPartners(node) {
    if (!node || !node.closest) return [];
    const card = node.closest(".src[data-section]");
    if (card) {
      const sec = document.getElementById(`rsec-${card.dataset.section}`);
      return sec ? [sec] : [];
    }
    // Evidence entries name their source, so they point at one card each.
    const ev = node.closest("[data-ev-src]");
    if (ev) {
      const one = document.getElementById(`src-${ev.dataset.evSrc}`);
      return one ? [one] : [];
    }
    // A summary row (#65) names exactly one section, so hovering it lights that
    // section — the same reciprocal highlight, from the card at the head of the
    // report. Tested before .rsection because the card lives inside the front page.
    const sum = node.closest(".r-sum-row[data-section]");
    if (sum) {
      const one = document.getElementById(`rsec-${sum.dataset.section}`);
      return one ? [one] : [];
    }
    const sec = node.closest(".rsection[data-section]");
    if (sec) return $$("#col-left .src[data-section]").filter((c) => c.dataset.section === sec.dataset.section);
    return [];
  }

  function setLinkHighlight(origin) {
    const next = linkPartners(origin);
    // Same partners AND they still wear the class — the include flash's cleanup
    // and a re-render in between can both strip it, and a highlight that has
    // silently gone missing must not be treated as still applied.
    if (next.length === LINKED.length && next.every((n, i) => n === LINKED[i] && n.classList.contains("is-linked"))) return;
    clearLinkHighlight();
    next.forEach((n) => n.classList.add("is-linked"));
    LINKED = next;
  }

  // One delegated pair on the document rather than listeners per card: both panes
  // re-render constantly, and a card that has just been replaced would otherwise
  // lose its wiring. Keyboard focus feeds the same setter, so tabbing the list
  // shows the same relationship the mouse does.
  function wirePaneLinking() {
    document.addEventListener("pointerover", (e) => setLinkHighlight(e.target));
    document.addEventListener("focusin", (e) => setLinkHighlight(e.target));
    // The pointer can leave the window without ever crossing an unrelated element.
    document.documentElement.addEventListener("pointerleave", clearLinkHighlight);
  }

  // The bottom row of a card's disposition zone: where this card lands in the
  // report, then — last on the card, in DOM order and on screen, where the
  // instructions have always said it belongs — the sign-off. Editing the card's
  // notes/photos afterwards updates the report live (the report re-renders from
  // state), so multiple sources can land in one section and stay in sync without
  // any copy/paste going stale.
  //
  // The destination used to be a 200px <select> carrying all eleven sections, on
  // every card, permanently — heavy machinery for a choice the default gets right
  // nearly every time. It reads as text now, with the full picker one click
  // behind "change", and including the card says where it went.
  // `opts.signoff: false` drops the sign-off pill from the row. Focus mode passes
  // it: there the step's Continue records the sign-off, and a pill beside it would
  // be a second control for one judgement.
  function renderIncludeRow(src, opts) {
    const o = opts || {};
    const f = state.findings[src.id] || (state.findings[src.id] = { status: STATUS.UNSET, note: "", result: null, images: [] });
    const included = cardIncluded(f);
    const btn = el("button", { type: "button", class: "btn tiny inc-btn" + (included ? " on" : ""),
      "aria-pressed": included ? "true" : "false",
      onclick: () => toggleInclude(src.id) }, included ? "✓ In report" : "＋ Include");

    const row = el("div", { class: "do-row include-row" + (included ? " is-in" : "") },
      el("span", { class: "do-lead" }, "Report"), renderIncludeTarget(src, f), btn,
      o.signoff === false ? null : renderSignOff(src, f));

    // The flight path: pressing Include used to land 3,000px down the other pane
    // with nothing on the card to say so. This names where it went, and the name
    // is the way there. Transient — see INCLUDE_FLASH.
    if (INCLUDE_FLASH.has(src.id))
      row.append(el("p", { class: "inc-receipt", role: "status" },
        el("span", { class: "inc-receipt-tick", "aria-hidden": "true" }, "✓"),
        "Added to ",
        el("button", { type: "button", class: "inc-dest-link",
          onclick: () => showReportSection(targetSectionOf(src, f)) }, sectionTitleOf(src, f)),
        el("span", { class: "inc-receipt-arrow", "aria-hidden": "true" }, "⇢")));
    return row;
  }

  // Where this card lands, as text. Deliberately NOT a link: the destination is
  // information at rest, and the trips to it are made where they are relevant —
  // the receipt after including, the reciprocal highlight on hover, and "Show in
  // the report" in the card's ⋯. "change" swaps in the real <select>, which is
  // where a correction belongs: one click away, not on all 23 cards at once.
  function renderIncludeTarget(src, f) {
    const wrap = el("span", { class: "inc-where" });
    const draw = () => {
      wrap.replaceChildren(
        el("span", { class: "inc-dest" },
          el("span", { class: "inc-dest-arrow", "aria-hidden": "true" }, "→"), sectionTitleOf(src, f)),
        el("button", { type: "button", class: "btn tiny tertiary inc-change",
          "aria-label": `Send ${src.name} to a different report section`,
          onclick: () => pick() }, "change"));
    };
    const pick = () => {
      const target = targetSectionOf(src, f);
      const sel = el("select", { class: "inc-target", "aria-label": `Report section ${src.name} feeds`,
        onchange: (e) => setTargetSection(src.id, e.target.value),
        // Leaving it without choosing anything is a cancel, not a commitment.
        onblur: () => { if (wrap.isConnected && wrap.contains(sel)) draw(); } });
      REPORT_SECTIONS.forEach((s) => sel.append(el("option", { value: s.id, selected: s.id === target ? "selected" : null }, s.title)));
      wrap.replaceChildren(sel);
      sel.focus();
    };
    draw();
    return wrap;
  }

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

  // Photos for a section come from the cards the operator has *included* into it
  // (see the Include control), de-duplicated so the same image never appears twice
  // in one section. Because each card targets a single section, a photo can no
  // longer bleed across sibling sections (habitat/flora/fauna) the way the old
  // category-wide rule allowed.
  function photosForSection(section) {
    const seen = new Set();
    const out = [];
    includedCardsForSection(section.id).forEach(({ src, f }) =>
      (f.images || []).forEach((im) => {
        const key = im.dataUrl || im.id;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ im, src });
      }));
    return out;
  }

  // ------------------------------------------------- narrative + QA helpers
  // Standardized narrative templates (data/statements.json); {} if not loaded.
  const STMT = () => DATA.statements || {};

  // Classify a PMST threatened-species row as flora vs fauna, so a Protected
  // Matters result can be split into the Flora and Fauna sections the way a human
  // does it by hand. Uses the taxonomic Class where present, else a name hint;
  // anything unresolved defaults to fauna (and the flora seed says so).
  const PLANT_CLASS_RE = /\b(flora|plant|plants|magnoliopsida|liliopsida|pteridopsida|polypodiopsida|pinopsida|cycadopsida|bryopsida|equisetopsida|gnetopsida|dicot|monocot)\b/i;
  const ANIMAL_CLASS_RE = /\b(bird|birds|aves|mammal|mammals|mammalia|reptil|amphib|fish|actinopterygii|chondrichthyes|shark|insect|insecta|snail|gastropoda|crustacea|malacostraca|arachnid)\b/i;
  const PLANT_NAME_RE = /\b(wattle|acacia|eucalyptus|corymbia|grevillea|orchid|grass|sedge|rush|fern|pea|daisy|lily|shrub|myrtle|banksia|hakea|boronia|pomaderris|correa|zieria|prostanthera|plectranthus|pepper-?cress|bluegrass|turpentine|greenhood|wildflower|cycad|sea-?berry|toadflax|cornflower|panic)\b/i;
  function pmstIsPlant(cls, name) {
    if (cls && PLANT_CLASS_RE.test(cls)) return true;
    if (cls && ANIMAL_CLASS_RE.test(cls)) return false;
    return PLANT_NAME_RE.test(name || "");
  }

  // QLD koala-district note for the Fauna section. Districts A/B cover South East
  // Queensland; the rest of the State is district C (where the plan's sequential
  // clearing rules do not apply). District is provisional from location only.
  function koalaNote(site) {
    const K = STMT().koala || {};
    if (!site || site.state !== "QLD" || !K.explainer) return "";
    const bb = K.seq_bbox || {}, lat = +site.lat, lon = +site.lon;
    const inSEQ = isFinite(lat) && isFinite(lon) &&
      lat >= bb.lat_min && lat <= bb.lat_max && lon >= bb.lon_min && lon <= bb.lon_max;
    const district = inSEQ ? K.district_ab : K.district_c;
    const tail = [K.explainer, district, K.confirm, K.link ? "See: " + K.link : ""].filter(Boolean).join(" ");
    return tail;
  }

  // Group {name, cat} rows by threatened category in severity order, e.g.
  // "Critically Endangered: A, B. Endangered: C." — mirrors the human paragraphs.
  const CAT_ORDER = ["Critically Endangered", "Endangered", "Vulnerable", "Conservation Dependent", "Extinct in the Wild", "Extinct"];
  function groupByCategory(list) {
    const g = {};
    list.forEach((x) => { const c = x.cat || "Listed"; (g[c] = g[c] || []).push(x.name); });
    return Object.keys(g)
      .sort((a, b) => { const ia = CAT_ORDER.indexOf(a), ib = CAT_ORDER.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); })
      .map((c) => `${c}: ${g[c].join(", ")}.`);
  }

  // Build {threatened_habitat, threatened_flora, threatened_fauna} section seeds
  // ({choice, note}) from a PMST "Known" result. When matters exist the choice is
  // the "Known to occur in the region but not present … at the site" wording
  // (opts[3], the honest reading of a 50 km buffer), falling back to "…local area"
  // (opts[2]) on older data; otherwise the "no known…" wording (opts[0]).
  function buildPmstSeeds(mnes, site) {
    const dd = DATA.dropdowns || {}, S = STMT();
    const localOpt = (k) => { const o = dd[k] || []; return o[3] || o[2] || o[1] || o[0] || ""; };
    const noneOpt = (k) => (dd[k] || [])[0] || "";
    const impact = S.impact_boilerplate ? "\n\n" + S.impact_boilerplate : "";

    // Habitat ← threatened ecological communities
    let habitat;
    if (mnes.communities.length) {
      habitat = { choice: localOpt("threatened_habitat"),
        note: `A Protected Matters search identified ${mnes.communities.length} threatened ecological communit${mnes.communities.length === 1 ? "y" : "ies"} recorded as Known in the wider search area:\n• ${groupByCategory(mnes.communities).join("\n• ")}\nKnown to occur in the region; not necessarily present within or immediately adjacent to the site. All other communities returned were Likely/May occurrences and are excluded.` };
    } else {
      habitat = { choice: noneOpt("threatened_habitat"),
        note: "A Protected Matters search identified no threatened ecological communities recorded as Known in the wider search area." };
    }

    const plants = mnes.species.filter((s) => pmstIsPlant(s.cls, s.name));
    const animals = mnes.species.filter((s) => !pmstIsPlant(s.cls, s.name));

    // Flora ← threatened species classified as plants
    let flora;
    if (plants.length) {
      flora = { choice: localOpt("threatened_flora"),
        note: `The PMST identified threatened flora recorded as Known in the wider region:\n• ${groupByCategory(plants).join("\n• ")}${impact}` };
    } else {
      flora = { choice: noneOpt("threatened_flora"),
        note: "The PMST identified no threatened flora recorded as Known in the wider region." };
    }

    // Fauna ← threatened species classified as animals, plus migratory (a separate
    // matter), plus the koala note where applicable.
    let fauna;
    if (animals.length || mnes.migratory.length) {
      const bits = [];
      if (animals.length) bits.push(`The PMST identified threatened fauna recorded as Known in the wider region:\n• ${groupByCategory(animals).join("\n• ")}`);
      if (mnes.migratory.length) bits.push(`Listed migratory species recorded as Known: ${mnes.migratory.map((m) => m.name).join(", ")}.` + (S.migratory_note ? " " + S.migratory_note : ""));
      let note = bits.join("\n\n");
      if (animals.length && S.impact_boilerplate) note += "\n\n" + S.impact_boilerplate;
      const kn = /koala/i.test(animals.map((a) => a.name).join(" ")) ? koalaNote(site) : "";
      if (kn) note += "\n\n" + kn;
      fauna = { choice: localOpt("threatened_fauna"), note };
    } else {
      fauna = { choice: noneOpt("threatened_fauna"),
        note: "The PMST identified no threatened fauna or migratory species recorded as Known in the wider region." };
    }

    return { threatened_habitat: habitat, threatened_flora: flora, threatened_fauna: fauna };
  }

  // Assemble a suggested detail paragraph for a section from its FOUND evidence
  // plus the standardized templates — the "Insert suggested detail" button.
  // Returns "" when there's nothing useful to offer.
  function sectionNarrative(section) {
    const S = STMT(), site = state.site || {};
    // Draw on the sources the operator has included into THIS section (main's
    // Include model, which replaced the old category-wide evidenceFor()).
    const ev = includedCardsForSection(section.id);
    const foundNotes = ev.filter((x) => x.f.status === "found").map((x) => findingText(x.f).trim()).filter(Boolean);
    const anyFound = ev.some((x) => x.f.status === "found");
    const parts = [];
    switch (section.id) {
      case "threatened_habitat":
        if (foundNotes.length) parts.push(foundNotes.join("\n\n"));
        break;
      case "threatened_flora":
        if (foundNotes.length) parts.push(foundNotes.join("\n\n"));
        if (anyFound && S.impact_boilerplate) parts.push(S.impact_boilerplate);
        break;
      case "threatened_fauna": {
        if (foundNotes.length) parts.push(foundNotes.join("\n\n"));
        if (anyFound && S.impact_boilerplate) parts.push(S.impact_boilerplate);
        const kn = koalaNote(site);
        if (kn && /koala/i.test(foundNotes.join(" "))) parts.push(kn);
        break;
      }
      case "indigenous_areas":
        if (foundNotes.length) parts.push(foundNotes.join("\n\n"));
        else if (S.no_ipa_note) parts.push(S.no_ipa_note);
        if (S.duty_of_care) parts.push(S.duty_of_care);
        break;
      case "heritage":
        if (foundNotes.length) parts.push(foundNotes.join("\n\n"));
        else if (S.no_heritage_note) parts.push(S.no_heritage_note);
        break;
      case "invasive_plants":
      case "invasive_animals":
      case "diseases":
        if (foundNotes.length) parts.push(foundNotes.join("\n\n"));
        break;
      case "additional": {
        // Note: the General Biosecurity Obligation is auto-seeded into the
        // Biosecurity section (see defaultSectionNote), so it is deliberately not
        // repeated here. Only add the acid-sulfate note, and only when that source
        // actually came back Found (never a blanket claim).
        const ass = sourcesForSite().find((s) => s.id === "acid-sulfate-soils");
        if (ass && (state.findings[ass.id] || {}).status === "found" && S.acid_sulfate_note) parts.push(S.acid_sulfate_note);
        break;
      }
    }
    return parts.filter(Boolean).join("\n\n").trim();
  }

  /* ------------------------------------------- the statement as its own signal
     The standardized statement lists are ordered [there are no known…, there are
     known…, …in the local area], so the INDEX of the operator's choice carries
     meaning on its own: option 0 asserts nothing is present, anything after it
     asserts matters ARE. Only the none/known scales say that — the biosecurity
     treatment scale is ordered by treatment, not by presence — so both readers of
     the signal (the consistency checker below, and the summary card at the head of
     the report) ask this one function whether a section's list is such a scale,
     rather than each testing the first option's wording for itself. */
  function statementScale(section) {
    if (!section || !section.dropdown) return null;
    const opts = DATA.dropdowns[section.dropdown] || [];
    return opts.length && /^there are no/i.test(opts[0]) ? opts : null;
  }
  // Does the section's own statement assert that matters are present? An unset or
  // unrecognised choice asserts nothing either way.
  function statementAssertsMatters(section, rstate) {
    const opts = statementScale(section);
    return !!opts && opts.indexOf((rstate && rstate.choice) || "") >= 1;
  }

  // Flag the mistakes the human sheets are full of: a standardized statement that
  // contradicts the section's evidence, or a "matters present" statement left with
  // no supporting detail. Only applies to the none/known-scale dropdowns (their
  // first option starts "There are no…"); skips the biosecurity treatment scale.
  // `ev` (the section's included cards) is passed in by the roll-up, which groups
  // every card by section in one pass rather than re-filtering the source list
  // eleven times per keystroke; on its own it falls back to the per-section query.
  function sectionWarnings(section, rstate, ev) {
    const opts = statementScale(section);
    if (!opts) return [];
    const idx = opts.indexOf(rstate.choice || "");
    if (idx < 0) return [];
    ev = ev || includedCardsForSection(section.id);
    const anyFound = ev.some((x) => x.f.status === "found");
    const note = rstate.note || "";
    const noteHasMatter = /\b(critically|endangered|vulnerable|threatened|listed|weed|weeds|pest|pests|declared|heritage|ramsar|world heritage)\b/i.test(note);
    const w = [];
    if (idx === 0 && (anyFound || noteHasMatter))
      w.push('Statement says "no known…" but the evidence or notes indicate matters were found — reconsider the statement or the note.');
    if (idx >= 1 && !anyFound && !note.trim())
      w.push("Statement indicates matters are present, but no supporting detail is recorded — add the specifics.");
    // The section states a conclusion while some of the sources behind it were
    // never opened — an interactive-only portal still to be queried, or a search
    // that failed. That is precisely the class of error this checker exists to
    // catch, and the one the old flat evidence list hid by rendering "requires
    // manual query" in the same block, at the same weight, as a confirmed matter.
    const unchecked = ev.filter((x) => isUnchecked(x.f));
    if (unchecked.length) {
      // Name the first two; a warning that runs to six source names is a
      // paragraph, and the caveat strip below it already lists every one.
      const names = unchecked.slice(0, 2).map((x) => x.src.name).join(", ");
      const rest = unchecked.length - 2;
      w.push(`This section's statement asserts a conclusion, but ${unchecked.length} of its sources ${unchecked.length === 1 ? "has" : "have"} not been checked: `
        + `${names}${rest > 0 ? ` and ${rest} more` : ""}.`);
    }
    return w;
  }

  // Rendering the report has always been where a section's state is first created
  // and its dropdown auto-suggested. Focus mode doesn't build the report pane, so
  // that seeding is split out and run from both — otherwise an export taken from
  // Focus would be missing every auto-suggested choice, and the two modes would
  // disagree about the same site.
  function ensureReportChoices() {
    if (!state.site) return;
    REPORT_SECTIONS.forEach((section) => {
      const rstate = state.report[section.id] || (state.report[section.id] = newReportState(section.id));
      if (rstate.choice == null && section.dropdown) rstate.choice = suggestChoice(section);
    });
  }

  /* ------------------------------------------- the report's front page (identity)
     Which site this is, and the pictures that establish it: the two locator maps
     and the station photographs. ONE section rather than the two headed blocks it
     used to be, because it carries one review tick — the operator confirms "this is
     the right place" once, not once per picture grid — and because that is exactly
     what Focus mode presents the moment the site work is done (the out:identity
     step). Both modes build it from these three functions, so the front page a
     Focus user signs off is the front page the report shows. */
  const IDENTITY_SECTION = "identity";

  // Both locator maps, side by side, square + equally sized (see .report-maps CSS).
  function reportMapsBlock() {
    const s = state.site;
    const ready = s ? MAP_SLOTS.filter((slot) => { const ms = state.maps[slot.key]; return ms && ms.image && ms.image.dataUrl; }) : [];
    if (!ready.length) return null;
    // Grid columns follow the number of ready maps, so a single (still-loading or
    // failed) slot fills the width instead of leaving an empty half.
    const row = el("div", { class: "report-maps", style: `grid-template-columns:repeat(${ready.length},1fr)` });
    ready.forEach((slot) => {
      const m = state.maps[slot.key].image;
      row.append(el("figure", { class: "report-map" },
        el("img", { src: m.dataUrl, alt: `${slot.title} — satellite locator`, loading: "lazy", decoding: "async",
          title: "Open the full-screen map — scroll to zoom, drag to pan",
          onclick: () => openLightbox(m.dataUrl, `${slot.title} — ${(+m.km).toLocaleString()} km across · ${s.name}`) }),
        el("figcaption", {}, `${slot.title} — ${(+m.km).toLocaleString()} km across · centred on ${s.lat}, ${s.lon} · ${MAP_ATTRIB}${m.labels ? " · " + MAP_REF_ATTRIB : ""}`)));
    });
    return el("div", { class: "r-identity-block" },
      el("h4", {}, ready.length > 1 ? "Location maps" : "Location map"), row);
  }

  function reportPhotosBlock() {
    if (!(state.siteImages || []).length) return null;
    const grid = el("div", { class: "photo-grid report-large" });
    state.siteImages.forEach((im) => grid.append(photoFigure(im, "", () => removeSiteImage(im.id))));
    return el("div", { class: "r-identity-block" }, el("h4", {}, "Site photographs"), grid);
  }

  function reportIdentitySection() {
    const rstate = state.report[IDENTITY_SECTION] || (state.report[IDENTITY_SECTION] = newReportState(IDENTITY_SECTION));
    const box = el("div", { class: "rsection rsec-identity" + (rstate.reviewed ? " is-reviewed" : ""),
      id: `rsec-${IDENTITY_SECTION}` });
    box.append(el("div", { class: "rsec-head" }, el("h3", {}, "Site and location"),
      identityReviewToggle(box)));
    const maps = reportMapsBlock(), photos = reportPhotosBlock();
    if (maps) box.append(maps);
    // Directly below the maps and above everything else: the first thing after the
    // reader has established where the site is (see reportSummaryBlock).
    const summary = reportSummaryBlock();
    if (summary) box.append(summary);
    if (photos) box.append(photos);
    // Said rather than left blank: an empty front page is either a map still being
    // stitched or one that failed, and both are worth naming where the reader is.
    if (!maps) box.append(el("p", { class: "r-sub" },
      MAP_SLOTS.some((slot) => (state.maps[slot.key] || {}).status === "loading")
        ? "The locator maps are still being generated."
        : "No locator map has been generated for this site yet — the site details step can retry it."));
    return box;
  }

  // The report's per-section review tick, wherever it is drawn: the report pane's
  // section head, the front page, and a Focus section step all build it here and
  // write the same flag through the same setter — so a tick in Focus and a tick in
  // the workbench are one tick, and the three can never drift apart in wording.
  //
  // Deliberately NOT the collection card's "Sign off": different word, different
  // control (a checkbox, not a pressed pill) and a different accent, because the
  // two used to be pixel-identical and mean different things.
  //
  // `opts.box` is the container to carry the is-reviewed class; `opts.inputId` is
  // passed by the Focus steps, whose re-render needs a stable id to hand the
  // keyboard focus back to. Two copies are never in the document at once — the
  // mode that isn't live has no report pane and no step body.
  const REVIEW_TITLE = "The report's own tally — tick once you've reviewed this section (separate from signing off the source cards)";
  function sectionReviewToggle(sectionId, opts) {
    const o = opts || {};
    const rstate = state.report[sectionId] || (state.report[sectionId] = newReportState(sectionId));
    const input = el("input", { type: "checkbox", id: o.inputId || null });
    input.checked = !!rstate.reviewed;
    const toggle = el("label", { class: "review-toggle" + (rstate.reviewed ? " on" : ""), title: o.title || REVIEW_TITLE },
      input, el("span", {}, rstate.reviewed ? "✓ Section reviewed" : "Mark section reviewed"));
    input.addEventListener("change", (e) => setSectionReviewed(sectionId, e.target.checked, o.box, toggle));
    return toggle;
  }

  function identityReviewToggle(box, inputId) {
    return sectionReviewToggle(IDENTITY_SECTION, { box, inputId,
      title: "The report's own tally — tick once you've checked the site, the maps and the photos are the right ones" });
  }

  function renderReport() {
    ensureReportChoices();
    // …but the pane itself is the workbench's. See renderDashboard() above.
    if (!workbenchLive()) return;
    const wrap = $("#report-sections");
    wrap.innerHTML = "";
    // Clamped finding notes, collected as they're built and measured once the
    // whole pane is in the document — see measureClamps().
    const clamps = [];
    if (state.site) wrap.append(reportIdentitySection());
    REPORT_SECTIONS.forEach((section) => {
      const rstate = state.report[section.id]; // seeded by ensureReportChoices() above

      // data-section is the join to the collection pane — see linkPartners() and
      // the scroll sync. Every card feeding this section carries the same value.
      const box = el("div", { class: "rsection" + (rstate.reviewed ? " is-reviewed" : ""),
        id: `rsec-${section.id}`, "data-section": section.id });
      // Per-section "Reviewed" tickbox — the REPORT's own tally. Updated in place
      // (no full report re-render) so ticking stays cheap on image-heavy sites.
      box.append(el("div", { class: "rsec-head" }, el("h3", {}, section.title),
        sectionReviewToggle(section.id, { box })));

      if (section.dropdown) {
        const opts = DATA.dropdowns[section.dropdown] || [];
        const sel = el("select", { onchange: (e) => { rstate.choice = e.target.value; save(); refreshSection(section, box, rstate); if (section.bioDetail) syncBioDetail(section, box); } });
        opts.forEach((o) => sel.append(el("option", { value: o, selected: rstate.choice === o ? "selected" : null }, o)));
        box.append(el("div", { class: "r-field" }, sel));
      }

      if (section.bioDetail) {
        const detail = el("p", { class: "r-sub", id: "bio-detail" });
        box.append(detail);
        setTimeout(() => syncBioDetail(section, box), 0);
      }

      // Consistency warnings — the class of mistake the human sheets are full of.
      // Lives in its own container so it can refresh live as the note is edited.
      const warnBox = el("div", { class: "r-warns" });
      box.append(warnBox);
      renderReportWarnings(section, box, rstate);

      // Reference link for invasive/disease sections (mirrors the proforma hyperlinks)
      const ref = section.ref && state.site.refs && state.site.refs[section.ref];
      if (ref) box.append(el("p", { class: "r-sub" }, "Reference: ", el("a", { href: ref, target: "_blank", rel: "noopener" }, ref)));

      const ta = el("textarea", { placeholder: "Free-text comments for this section…", oninput: (e) => { rstate.note = e.target.value; refreshSection(section, box, rstate); save(); } });
      ta.value = rstate.note || "";
      box.append(el("div", { class: "r-field" }, ta));

      // Draft a standardized paragraph from the evidence + standard wording. Fills
      // an empty note, or appends below existing text — never overwrites.
      const suggestion = sectionNarrative(section);
      if (suggestion) {
        const btn = el("button", { class: "btn-mini", type: "button",
          title: "Draft this section from the collected evidence and standard wording (appends; never overwrites)",
          onclick: () => {
            const cur = (ta.value || "").trim();
            ta.value = cur ? cur + "\n\n" + suggestion : suggestion;
            rstate.note = ta.value; refreshSection(section, box, rstate); save();
          } }, "Insert suggested detail");
        box.append(el("div", { class: "r-actions" }, btn));
      }

      // Included sources: each card the operator added to THIS section contributes
      // its status, notes and photos — split by what the entry actually is (see
      // renderSectionEvidence), de-duplicated, and every photo individually
      // removable. Editing the card updates this live.
      const evidence = renderSectionEvidence(includedCardsForSection(section.id), clamps);
      if (evidence) box.append(evidence);
      wrap.append(box);
    });
    // Appendix last, after every report section — see qldMapAppendix().
    const appendix = qldMapAppendixRows();
    if (appendix) {
      const box = el("div", { class: "rsection rsec-appendix", id: "rsec-appendix-map-layers" },
        el("div", { class: "rsec-head" }, el("h3", {}, appendix.title)),
        el("p", { class: "r-sub" }, appendix.blurb));
      const list = el("div", { class: "r-appendix" });
      appendix.groups.forEach((g) => {
        list.append(el("div", { class: "r-appendix-group" },
          el("h4", {}, g.title),
          g.source ? el("p", { class: "r-appendix-src r-appendix-gsrc" }, g.source) : null,
          el("ul", {}, g.layers.map(appendixItem))));
      });
      box.append(list);
      wrap.append(box);
    }
    measureClamps(clamps); // now everything is in the document, so heights are real
    renderReportHeader(); // identity + roll-ups, from the state just rendered
    renderStarvedSections(); // …and the collection pane's view of which are still empty
  }

  /* ------------------------------------------------ a section's evidence, split
     Three different things used to render identically. On the fixture site twelve
     of a section list's twenty "evidence" blocks were not evidence at all: four
     said nothing was found, six said an interactive portal "requires manual
     query", two said a search had failed — each in the same grey panel, at the
     same weight, as a confirmed EPBC matter. Threatened Habitat looked thoroughly
     evidenced while resting on one real result and four notes about tools nobody
     had opened. The honesty was in the data; the layout undid it.

     So entries are grouped by what they ARE, not merely tagged with an 11 px pill:

       Findings                  found            full weight — these carry the conclusion
       Checked, nothing found    none             one line naming the sources
       Not yet checked           manual/failed/…  a caveat strip, not a finding

     Returns null when the section has nothing included. */
  const EV_FINDINGS_SHOWN = 3; // findings expanded before "+ n more"

  // Where a source name in the evidence GOES, said in the words of the mode the
  // operator is standing in. The workbench scrolls the collection pane onto its
  // card; Focus makes that source's step the screen and — because the jump started
  // on a section step — arms the way straight back (see showSourceCard).
  const evGoTitle = (name) => focusLive()
    ? `Go to ${name} — Continue there brings you straight back to this section`
    : `Go to ${name} on the collection list`;
  function evidenceSplit(inc) {
    const out = { found: [], none: [], open: [] };
    inc.forEach((x) => {
      const st = x.f.status || STATUS.UNSET;
      if (st === STATUS.FOUND) out.found.push(x);
      else if (st === STATUS.NONE) out.none.push(x);
      else out.open.push(x); // manual / failed / unset — nobody has answered this one yet
    });
    return out;
  }
  // Whether this card still owes the section an answer. Shared with
  // sectionWarnings so the caveat strip and the warning can't disagree.
  const isUnchecked = (f) => (f.status || STATUS.UNSET) !== STATUS.FOUND && (f.status || STATUS.UNSET) !== STATUS.NONE;

  function renderSectionEvidence(inc, clamps) {
    if (!inc.length) return null;
    const { found, none, open } = evidenceSplit(inc);
    const wrap = el("div", { class: "r-evidence" });
    // One dedupe set for the whole section: the same photo attached to two
    // included sources is still shown once, as it always was.
    const seenImg = new Set();

    if (found.length) {
      const grp = el("div", { class: "r-included" },
        el("h4", { class: "r-ev-title" }, "Findings", el("span", { class: "r-ev-count" }, `${found.length}`)));
      // Beyond the third, findings are built but folded away: a section that
      // genuinely has eight results should say so without becoming a wall.
      const folded = [];
      found.forEach(({ src, f }, i) => {
        const item = evidenceItem(src, f, seenImg, clamps);
        if (i >= EV_FINDINGS_SHOWN) { item.hidden = true; folded.push(item); }
        grp.append(item);
      });
      if (folded.length) {
        const more = el("button", { type: "button", class: "btn tiny r-ev-more",
          title: "Show the rest of this section's findings",
          onclick: () => {
            folded.forEach((n) => { n.hidden = false; });
            more.remove();
            measureClamps(clamps); // the notes just revealed have real heights now
          } }, `+ ${folded.length} more finding${folded.length === 1 ? "" : "s"}`);
        grp.append(more);
      }
      wrap.append(grp);
    }

    // "We looked at these four and found nothing" is one sentence, not four panels.
    if (none.length)
      wrap.append(el("p", { class: "r-ev-line r-ev-none" },
        el("span", { class: "r-ev-label" }, `Checked, nothing found (${none.length})`),
        evSourceList(none)));

    // The honest reading of a manual/failed/unset entry — and the one that creates
    // useful pressure to go and finish it.
    if (open.length)
      wrap.append(el("div", { class: "r-ev-caveat" },
        el("p", { class: "r-ev-line" },
          el("span", { class: "r-ev-label" }, `⚠ Not yet checked (${open.length})`),
          evSourceList(open, (f) => f.status === STATUS.FAILED ? " (search failed)" : ""),
          el("button", { type: "button", class: "r-ev-goto",
            title: `These sources still owe this section an answer — ${evGoTitle(open[0].src.name)}`,
            onclick: () => showSourceCard(open[0].src.id) },
            focusLive() ? "go and check these →" : "go to these in collection →"))));

    // A collapsed entry's PICTURES are not collapsed with it. The Queensland Globe
    // capture rides on a source that is almost always still "manual", and it is the
    // one picture in the report that has to be read rather than glanced at — so the
    // media stays, with its remove controls, below the strips. Each keeps its
    // source's name, which it used to get from the panel it sat in.
    const media = el("div", { class: "r-ev-media" });
    [...none, ...open].forEach(({ src, f }) => {
      const holder = el("div", { class: "r-ev-media-item" });
      if (!appendEvidenceImages(holder, src, f, seenImg)) return;
      holder.prepend(el("p", { class: "r-ev-media-src" }, src.name));
      media.append(holder);
    });
    if (media.children.length) wrap.append(media);
    return wrap;
  }

  // One finding, at full weight: status, source, its prose (clamped to three lines
  // until asked otherwise) and its pictures.
  function evidenceItem(src, f, seenImg, clamps) {
    const st = f.status && f.status !== STATUS.UNSET ? f.status : STATUS.UNSET;
    // Same number this source carries on its collection card (left pane) so the
    // two columns can be cross-referenced at a glance. On-screen aid only — the
    // number is NOT part of reportObject()/buildReportHtml, so it never reaches
    // the exported/printed report.
    const num = cardNumbers[src.id];
    // The source's NAME is the way back to its card — the same pattern the
    // collapsed strips below already use. It replaces a standing "⇠ Show" button
    // on every entry whose visible label never said where it went.
    const head = el("div", { class: "r-inc-head" },
      num ? el("span", { class: "src-num", title: "Collection card number (left pane)" }, `${num}`) : null,
      el("span", { class: "chip " + (st === STATUS.UNSET ? "manual" : st), style: st === STATUS.UNSET ? "opacity:.5" : "" }, STATUS_LABEL[st]),
      el("button", { type: "button", class: "r-inc-name",
        "aria-label": evGoTitle(src.name), title: evGoTitle(src.name),
        onclick: () => showSourceCard(src.id) }, src.name),
      el("div", { class: "r-inc-actions" },
        el("button", { type: "button", class: "btn tiny r-inc-remove", title: "Remove this source from the report section", onclick: () => toggleInclude(src.id) }, "Remove")));
    const item = el("div", { class: "r-inc-item status-" + st, "data-ev-src": src.id }, head);
    if (f.note && f.note.trim()) {
      const note = el("div", { class: "r-inc-note is-clamped" }, f.note.trim());
      // Hidden until measurement proves there is more to show — a two-line note
      // with a "Show all" under it is a control that does nothing.
      const toggle = el("button", { type: "button", class: "r-inc-more", hidden: "hidden", "aria-expanded": "false",
        onclick: () => {
          const clamped = note.classList.toggle("is-clamped");
          toggle.textContent = clamped ? "Show all" : "Show less";
          toggle.setAttribute("aria-expanded", clamped ? "false" : "true");
        } }, "Show all");
      item.append(note, toggle);
      clamps.push({ note, toggle });
    }
    const shown = appendEvidenceImages(item, src, f, seenImg);
    if ((!f.note || !f.note.trim()) && !shown)
      item.append(el("div", { class: "r-inc-empty" }, "Included — add notes or photos on the source card."));
    return item;
  }

  // A card's pictures, wherever they are being shown. Returns how many were added
  // (0 when every one of them was already rendered elsewhere in this section).
  function appendEvidenceImages(node, src, f, seenImg) {
    const imgs = (f.images || []).filter((im) => { const k = im.dataUrl || im.id; if (seenImg.has(k)) return false; seenImg.add(k); return true; });
    // The Queensland Globe map is the one picture in the report that has to be
    // READ, not glanced at — it gets the full width of the section, exactly as
    // the exported report renders it.
    imgs.filter(isQldMapImage).forEach((im) =>
      node.append(qldMapFigure(im, () => removeFindingImage(src.id, im.id))));
    const photos = imgs.filter((im) => !isQldMapImage(im));
    if (photos.length) {
      const grid = el("div", { class: "photo-grid small" });
      photos.forEach((im) => grid.append(photoFigure(im, src.name, () => removeFindingImage(src.id, im.id))));
      node.append(grid);
    }
    return imgs.length;
  }

  // The sources named inside a collapsed strip. Each name is a button, not text:
  // the whole point of collapsing these is that the detail stays on the card, so
  // every name has to be the way back to it.
  function evSourceList(rows, suffixOf) {
    const out = [];
    rows.forEach(({ src, f }, i) => {
      if (i) out.push(el("span", { class: "r-ev-sep", "aria-hidden": "true" }, "·"));
      const num = cardNumbers[src.id];
      out.push(el("button", { type: "button", class: "r-ev-src", "data-ev-src": src.id,
        title: evGoTitle(src.name), onclick: () => showSourceCard(src.id) },
        num ? el("span", { class: "src-num" }, `${num}`) : null,
        src.name + (suffixOf ? suffixOf(f) : "")));
    });
    return out;
  }

  // "Show all" only earns its place when the note is actually longer than the
  // clamp, which can only be known once the block is in the document — and again
  // when "+ n more" reveals one that was folded away (heights are 0 while hidden).
  function measureClamps(clamps) {
    if (!clamps.length) return;
    requestAnimationFrame(() => {
      clamps.forEach(({ note, toggle }) => {
        if (!note.isConnected) return;
        const clamped = note.classList.contains("is-clamped");
        toggle.hidden = clamped && note.scrollHeight <= note.clientHeight + 2;
      });
    });
  }

  /* ------------------------------------------------ the report's own roll-up
     One pass over the report's state, shared by the sticky document header and
     the completeness summary at the foot of the pane, so the two can never
     disagree about how finished this report is. Called on every edit to a
     section (a tick, a statement, a keystroke in a note), so it groups the
     included cards by section itself rather than asking includedCardsForSection
     eleven times over. */
  function reportRollup() {
    const bySection = {};
    if (state.site)
      sourcesForSite().forEach((src) => {
        const f = state.findings[src.id] || {};
        // Same exclusions as includedCardsForSection: internal working items
        // never reach the report, on screen or in an export.
        if (src.internal || !cardIncluded(f)) return;
        const target = targetSectionOf(src, f);
        if (target) (bySection[target] || (bySection[target] = [])).push({ src, f });
      });
    const out = { total: REPORT_SECTIONS.length, reviewed: 0, warnings: [], warnCount: 0,
      unreviewed: [], noChoice: [], noNote: [], noEvidence: [] };
    REPORT_SECTIONS.forEach((section) => {
      const rstate = state.report[section.id] || {};
      const ev = bySection[section.id] || [];
      if (rstate.reviewed) out.reviewed++; else out.unreviewed.push(section);
      const warns = sectionWarnings(section, rstate, ev);
      if (warns.length) { out.warnings.push({ section, count: warns.length }); out.warnCount += warns.length; }
      if (section.dropdown && !(rstate.choice || "").trim()) out.noChoice.push(section);
      if (!(rstate.note || "").trim()) out.noNote.push(section);
      if (!ev.length) out.noEvidence.push(section);
    });
    return out;
  }

  /* ------------------------------------- the traffic-light summary card (#65)
     Someone about to attend a site does not read an ESS. They skim it, looking for
     the one thing that changes what they do today: is there something here I need
     to worry about? That answer was distributed across eleven sections and twenty
     evidence blocks — the tool knew it per section and never said it in one place.

     So: one row per report section, one marker per row, at the head of the report.
     Extremely high level, deliberately — no counts of species, no source names, no
     narrative. Its only job is to point at the sections worth reading.

     summaryRollup() is pure and takes nothing, so the report pane, Focus mode's
     front page and the exported artefact all render from the same array and cannot
     disagree about a marker.

     THREE states, not two. "Checked, nothing found" and "never checked" are
     different risk positions for someone about to attend a site (see
     docs/ARCHITECTURE.md, "The status taxonomy") — a binary marker would paint a
     section resting on four unopened portals the same green as one that was
     properly cleared, which is the exact failure the evidence split was built to
     stop, reintroduced at the top of the page in a bigger font.

     Colour is never the only carrier: every row renders the glyph AND the words,
     so it survives a greyscale photocopier and a screen reader. The glyphs live
     here rather than in the stylesheet's --glyph-* set (which statusDot draws
     from) because these four must also travel into the exported artefact, which
     carries its own stylesheet and cannot see styles.css. One definition, three
     surfaces.

     Not to be confused with renderFindingsGlance() below: that instrument counts
     SOURCES by status for the operator in Focus mode's finish step. This one marks
     SECTIONS for whoever reads the report. */
  const SUM_STATES = {
    found:   { glyph: "●", label: "Found — read this section" },  // ● filled
    partial: { glyph: "◐", label: "Not fully checked" },          // ◐ half
    clear:   { glyph: "○", label: "Checked, nothing found" },     // ○ hollow
    na:      { glyph: "–", label: "No sources apply" },           // – dash
  };

  /* Computed from EVERY applicable source routed to the section, not from the ones
     the operator pressed ＋ Include on. This is the one place the summary is
     allowed to disagree with the section body below it: the evidence list is
     include-driven, so a source that came back Found but was never pressed into
     the report contributes nothing to it. For a card whose entire purpose is "is
     there something here I need to worry about", silently under-reporting because
     of a missed button press is the one failure mode that could actually hurt
     someone. The rollup sees the finding regardless.

     It reads applicableSources() rather than sourcesForSite(), so internal /
     login-only sources count here even though their notes never reach the report.
     Two reasons, and the first is decisive: on most sites the ONLY source routed to
     Permits is the Bureau's own permits register, and to Biosecurity the POPE /
     leasing files — excluding them would print "No sources apply" against permits
     for a site whose permit position nobody had checked, which is the most
     dangerous sentence this card could carry. The second is that sourcesForSite()
     follows a checkbox in the collection header, and a marker on the report that
     moved when a display toggle was ticked would be a marker nobody could trust.

     "Still needs someone" is isOutstanding — the same definition the collection
     bar, the rail badges and the group roll-ups count with. */
  function summaryRollup() {
    if (!state.site || !REPORT_SECTIONS.length) return [];
    // One pass over the source list, grouped by target section, rather than eleven
    // filtered passes — this runs on every report render.
    const bySection = {};
    applicableSources().forEach((src) => {
      const f = state.findings[src.id] || {};
      const target = targetSectionOf(src, f);
      if (target) (bySection[target] || (bySection[target] = [])).push(f);
    });
    return REPORT_SECTIONS.map((sec) => {
      const list = bySection[sec.id] || [];
      const foundCount = list.filter((f) => statusOf(f) === STATUS.FOUND).length;
      const openCount = list.filter(isOutstanding).length;
      const rstate = state.report[sec.id] || {};
      // A "matters present" statement reads as a finding even with no found source
      // behind it: the operator has asserted it in the section's own words, and the
      // reader is entitled to be sent to the section that says so.
      let st;
      if (foundCount || statementAssertsMatters(sec, rstate)) st = "found";
      else if (!list.length) st = "na";
      else if (openCount) st = "partial";
      else st = "clear";
      return { section: sec.id, title: sec.title, state: st, foundCount, openCount };
    });
  }

  // One line above the table: what the table adds up to. A sentence, not a second
  // instrument — the rows are the thing, this is the reason to read them.
  function summaryVerdict(rows) {
    const need = rows.filter((r) => r.state === "found").length;
    const open = rows.filter((r) => r.state === "partial").length;
    if (rows.every((r) => r.state === "na")) return "No sources apply to this site yet.";
    if (!need && !open) return "Nothing found, and every section that applies has been checked.";
    const bits = [];
    if (need) bits.push(`${need} section${need === 1 ? "" : "s"} ${need === 1 ? "has" : "have"} findings to read`);
    // Naming the unit again once "sections" has already been said would be noise —
    // but standing on its own, a bare count says nothing about what was counted.
    if (open) bits.push(need
      ? `${open} ${open === 1 ? "is" : "are"} not fully checked`
      : `${open} section${open === 1 ? "" : "s"} ${open === 1 ? "is" : "are"} not fully checked`);
    return bits.join(" · ");
  }

  /* The card as a free-standing node, mounted on the report's front page directly
     below the locator maps — in the report pane and on Focus mode's front-page
     step, which builds from these same blocks.

     Every row is a control: a jump to its section (showReportSection resolves to a
     scroll in the workbench and to that section's step in Focus), and `data-section`
     makes hovering a row light the section it points at, through the same
     reciprocal highlight a collection card gets (see linkPartners).

     Sections with no applicable source are still listed, greyed, rather than
     omitted: "we considered permits and none apply here" is information, and a
     table whose row count changes per site is harder to trust at a glance. */
  function reportSummaryBlock() {
    const rows = summaryRollup();
    if (!rows.length) return null;
    const list = el("ul", { class: "r-sum" });
    rows.forEach((r) => {
      const s = SUM_STATES[r.state];
      list.append(el("li", { class: "r-sum-row", "data-sum": r.state, "data-section": r.section },
        el("button", { type: "button", class: "r-sum-hit",
          title: `Go to ${r.title}`,
          "aria-label": `${s.label} — ${r.title}. Go to this section.`,
          onclick: () => showReportSection(r.section) },
          // aria-hidden: the state is already spoken by the words beside it, and by
          // the row's own label. The glyph is for eyes and for photocopiers.
          el("span", { class: "r-sum-mark", "aria-hidden": "true" }, s.glyph),
          el("span", { class: "r-sum-state" }, s.label),
          el("span", { class: "r-sum-name" }, r.title))));
    });
    return el("div", { class: "r-identity-block r-summary", role: "group", "aria-label": "Findings at a glance" },
      el("h4", {}, "Findings at a glance"),
      el("p", { class: "r-sum-verdict" }, summaryVerdict(rows)),
      list);
  }

  // Refreshed in place. Changing a section's standardized statement moves a marker
  // (see summaryRollup) but deliberately does NOT run renderReport() — the section
  // refreshes itself so a keystroke never rebuilds an image-heavy pane — so the one
  // card that reads every statement has to be replaceable on its own. Called from
  // refreshSection(), the single funnel every section edit already goes through.
  function refreshSummaryCard() {
    $$(".r-summary").forEach((cur) => {
      const next = reportSummaryBlock();
      if (next) cur.replaceWith(next); else cur.remove();
    });
  }

  /* ------------------------------------------------- findings at a glance (#65)
     The "did I miss anything?" instrument: every source this site has, grouped by
     what it came back with, in the order the answer matters — the findings first,
     then everything a human still owns, then the empty searches that are good news.

     ONE implementation, deliberately. Focus mode's finish step is where it earns
     its keep (it is the only place in that mode that looks at the whole
     assessment at once), and it is written as a free-standing node so the report
     pane can mount the same card at its head without a second copy appearing.

     Status is carried by the count, the word AND the glyph — `statusDot` renders
     an empty span that the stylesheet's one status vocabulary fills, so this card
     cannot drift from the chips, the dots or the result picker. */
  const GLANCE_ROWS = [
    { key: STATUS.FOUND, says: "a matter is present at or near the site" },
    { key: STATUS.MANUAL, says: "the check needs a person — a portal, a login, a visit" },
    { key: STATUS.FAILED, says: "the check was attempted and could not be completed" },
    { key: STATUS.UNSET, says: "nobody has looked yet" },
    { key: STATUS.NONE, says: "checked, and nothing relevant came back" },
  ];

  function renderFindingsGlance() {
    const c = statusCounts();
    const box = el("div", { class: "glance", role: "group", "aria-label": "Findings at a glance" });
    box.append(el("p", { class: "glance-lead" + (c.n && !c.outstanding ? " is-clear" : "") },
      outstandingSentence(c)));
    if (!c.n) return box;
    const rows = el("ul", { class: "glance-rows" });
    GLANCE_ROWS.forEach((row) => {
      const n = c.byStatus[row.key] || 0;
      // The first source carrying this result, which is what the row jumps to. A
      // row with none has nowhere to go, so it is rendered as a fact rather than
      // as a control — a zero on "Not checked" is the reassurance this card
      // exists to give, and it must still be shown.
      const first = n ? sourcesForSite().find((s) => statusOf(state.findings[s.id] || {}) === row.key) : null;
      const kids = [
        statusDot(row.key),
        el("span", { class: "glance-n" }, String(n)),
        el("span", { class: "glance-label" }, STATUS_LABEL[row.key]),
        el("span", { class: "glance-says" }, row.says),
      ];
      rows.append(el("li", { class: "glance-row" + (n ? "" : " is-zero"), "data-status": row.key },
        first
          ? el("button", { type: "button", class: "glance-hit",
              title: `Go to the first: ${first.name}`,
              "aria-label": `${n} ${STATUS_LABEL[row.key]} — ${row.says}. Go to the first, ${first.name}.`,
              onclick: () => showSourceCard(first.id) }, kids)
          : el("span", { class: "glance-hit" }, kids)));
    });
    box.append(rows);
    return box;
  }

  // The document header: who this report is for, how far through it is, and what
  // the consistency checker has to say. Text-only updates against markup that is
  // already in the page, so every path that changes a section can call it without
  // re-rendering the report itself.
  // What the document header SAYS, apart from where it is drawn. Focus mode shows
  // the report's real front page on its out:identity step rather than a paraphrase
  // of it, and this is what keeps the two from drifting into different wordings of
  // the same station.
  function reportIdentityText() {
    const s = state.site || {};
    return {
      name: s.name || "ESS report",
      // The same identifiers the exported report's front table carries, in the
      // order an operator reads them out: who, where, when.
      ids: [
        s.station_num && `#${s.station_num}`,
        s.state, s.delivery_group,
        `${s.lat}, ${s.lon}`,
        state.date ? `assessed ${formatDate(state.date)}` : null,
      ].filter(Boolean).join(" · "),
      // The rest of the station record, one disclosure away — it belongs to the
      // document, but it isn't what tells two open sites apart.
      detail: [
        ["WMO number", s.wmo || "—"],
        ["Facility", (s.facility_types && s.facility_types.join(", ")) || s.primary_facility || "—"],
        ["Site maintenance", (state.maintenance || "").trim() || "—"],
      ],
    };
  }

  function renderReportHeader() {
    const s = state.site;
    if (!s || !$("#rdoc-name")) return;
    const idt = reportIdentityText();
    $("#rdoc-name").textContent = idt.name;
    $("#rdoc-ids").textContent = idt.ids;

    const detail = $("#rdoc-detail");
    if (detail) {
      detail.innerHTML = "";
      idt.detail.forEach(([k, v]) => detail.append(
        el("div", { class: "rdoc-detail-row" }, el("dt", {}, k), el("dd", {}, v))));
    }

    const r = reportRollup();
    const prog = $("#rdoc-progress");
    if (prog) prog.textContent = `${r.reviewed} of ${r.total} sections reviewed`;
    const fill = $("#rdoc-fill");
    if (fill) fill.style.width = `${r.total ? Math.round((r.reviewed / r.total) * 100) : 0}%`;

    // A warning three sections down used to be invisible until you scrolled onto
    // it. The count lives up here, and takes you to the first one.
    const warn = $("#btn-rdoc-warnings");
    if (warn) {
      warn.hidden = !r.warnCount;
      if (r.warnCount) {
        const first = r.warnings[0].section;
        warn.textContent = `⚠ ${r.warnCount} consistency warning${r.warnCount === 1 ? "" : "s"}`;
        warn.title = `First: ${first.title} — go to it`;
        warn.onclick = () => showReportSection(first.id);
      }
    }
    renderReportCompleteness(r);
  }

  // What is still empty, as a list of { list, text } — one definition of "a gap in
  // this report", shared by the pane's completeness box and by Focus mode's finish
  // step, so the two can never name different gaps for the same state. Only the
  // gaps that exist come back; an empty array IS "nothing missing".
  function completenessGaps(r) {
    return [
      { list: r.noChoice, text: (n) => `${n} with no statement chosen` },
      { list: r.noNote, text: (n) => `${n} with an empty comment` },
      { list: r.noEvidence, text: (n) => `${n} with no evidence included` },
      { list: r.unreviewed, text: (n) => `${n} still to review` },
    ].filter((g) => g.list.length);
  }

  // Where the section list ends: what is still empty. The report used to simply
  // stop, without ever saying whether it was finished.
  function renderReportCompleteness(r) {
    const box = $("#report-complete");
    if (!box) return;
    box.innerHTML = "";
    const gaps = completenessGaps(r);
    if (!gaps.length) {
      box.append(el("p", { class: "r-complete-lead is-done" },
        `All ${r.total} sections carry a statement, a comment and included evidence — and every one is reviewed.`));
      return;
    }
    box.append(el("p", { class: "r-complete-lead" }, `Of ${r.total} sections:`));
    box.append(el("ul", { class: "r-complete-list" }, gaps.map((g) =>
      el("li", {}, el("button", {
        type: "button", class: "r-complete-gap",
        title: `Go to the first: ${g.list[0].title}`,
        onclick: () => showReportSection(g.list[0].id),
      }, g.text(g.list.length))))));
  }

  /* --------------------------------------------------- QLD Globe map appendix
     There are forty-odd layers behind a Queensland Globe map. Drawing their
     names onto the picture buries the map, and listing them in a report section
     buries the findings — so they go at the END of the report, as an appendix,
     grouped exactly as the map's own catalogue groups them. Returns null when
     no map has been captured for this site, so nothing empty is ever rendered.
     Shared by the on-screen report, the printable/exported HTML and the JSON. */
  function qldMapAppendixRows() {
    const cap = state.site && state.qldMap && state.qldMap.capture;
    if (!cap || !Array.isArray(cap.layers) || !cap.layers.length) return null;
    const groups = [];
    const byTitle = new Map();
    cap.layers.forEach((l) => {
      const title = l.group || "Layers";
      if (!byTitle.has(title)) { const g = { title, layers: [] }; byTitle.set(title, g); groups.push(g); }
      byTitle.get(title).layers.push({
        name: l.name || l.id, service: l.service || "", url: l.url || "",
        legend: safeLegend(l.legend), legendMore: Math.max(0, +l.legend_more || 0),
      });
    });
    // Where a whole group comes from one service, name it ONCE under the group
    // heading. Repeating "Matters of State Environmental Significance" under all
    // nineteen of its layers is noise that pushes the layer names apart and
    // makes the appendix twice as long as it needs to be.
    groups.forEach((g) => {
      const services = [...new Set(g.layers.map((l) => l.service).filter(Boolean))];
      if (services.length === 1) { g.source = services[0]; g.layers.forEach((l) => { l.service = ""; }); }
    });
    const when = cap.at ? new Date(cap.at).toLocaleString("en-AU") : "";
    const where = (cap.lat != null && cap.lon != null) ? `${cap.lat}, ${cap.lon}` : `${state.site.lat}, ${state.site.lon}`;
    const withKeys = groups.some((g) => g.layers.some((l) => l.legend.length));
    return {
      title: "Appendix A — Queensland Globe map layers",
      blurb: `The site map in this report was drawn over the ${cap.layers.length} Queensland Government spatial layer${cap.layers.length === 1 ? "" : "s"} listed below, `
        + `centred on ${where}${cap.scale ? ` at approximately 1:${(+cap.scale).toLocaleString()}` : ""}${when ? `, captured ${when}` : ""}. `
        // Without this the appendix is a list of names beside a map full of
        // unexplained colour — the swatches ARE the legend, so say so.
        + (withKeys ? "The swatch beside each layer is the symbol that layer is drawn with on the map, as published by the service itself. " : "")
        + "Layer currency and authoritative symbology remain those published by the Queensland Government.",
      count: cap.layers.length,
      hasKeys: withKeys,
      groups,
    };
  }

  // A layer's legend swatches, taken from the capture record (or an imported
  // findings file) and made safe to interpolate into exported HTML: every
  // swatch must be a data: image the same way every photo must be.
  // Matches CFG.legendMaxPerLayer in qldmap.js — the cap is re-applied here so
  // an imported (or hand-written) findings file can't make the appendix
  // hundreds of swatches long.
  const MAX_LEGEND_KEYS = 8;
  function safeLegend(list) {
    if (!Array.isArray(list)) return [];
    return list
      .map((k) => ({ label: String((k && k.label) || "").trim(), swatch: (k && k.swatch) || "" }))
      .filter((k) => DATA_IMG_RE.test(k.swatch))
      .slice(0, MAX_LEGEND_KEYS);
  }

  /* One appendix entry: the layer name and its legend box — the colour and
     pattern the map actually draws that layer with. A single unlabelled swatch
     (a simple renderer: one symbol for the whole layer) sits inline against the
     name; a classified layer gets its classes listed underneath, because THAT
     is the case where the reader cannot otherwise tell which shade meant what.
     Shared shape with appendixItemHtml below — keep the two in step. */
  function appendixItem(l) {
    const inline = l.legend.length === 1 && !l.legend[0].label;
    const li = el("li", { class: "r-appendix-item" },
      el("span", { class: "r-appendix-lname" },
        inline ? el("img", { class: "r-legend-swatch", src: l.legend[0].swatch, alt: "", loading: "lazy" }) : null,
        l.name),
      l.service ? el("span", { class: "r-appendix-src" }, l.service) : null);
    if (!inline && l.legend.length)
      li.append(el("div", { class: "r-legend" }, l.legend.map((k) =>
        el("span", { class: "r-legend-key" },
          el("img", { class: "r-legend-swatch", src: k.swatch, alt: "", loading: "lazy" }),
          el("span", { class: "r-legend-label" }, k.label)))));
    if (l.legendMore)
      li.append(el("span", { class: "r-legend-more" }, `+${l.legendMore} further class${l.legendMore === 1 ? "" : "es"} in this layer's published legend`));
    if (!l.legend.length)
      li.append(el("span", { class: "r-legend-more" }, "symbology not published by the service"));
    return li;
  }
  // The same entry as an HTML string, for the printed / exported report.
  function appendixItemHtml(l) {
    const inline = l.legend.length === 1 && !l.legend[0].label;
    const swatch = (k) => `<img class="pr-legend-swatch" src="${esc(k.swatch)}" alt="">`;
    const keys = !inline && l.legend.length
      ? `<span class="pr-legend">${l.legend.map((k) =>
        `<span class="pr-legend-key">${swatch(k)}<span>${esc(k.label)}</span></span>`).join("")}</span>` : "";
    const more = l.legendMore
      ? `<span class="pr-legend-more">+${l.legendMore} further class${l.legendMore === 1 ? "" : "es"} in this layer's published legend</span>`
      : (l.legend.length ? "" : `<span class="pr-legend-more">symbology not published by the service</span>`);
    return `<li>${inline ? swatch(l.legend[0]) : ""}${esc(l.name)}`
      + `${l.service ? `<span class="pr-appendix-src">${esc(l.service)}</span>` : ""}${keys}${more}</li>`;
  }

  function syncBioDetail(section, box) {
    const rstate = state.report[section.id];
    const detail = box.querySelector("#bio-detail") || $("#bio-detail");
    const map = DATA.dropdowns.biosecurity_detail || {};
    if (detail) detail.textContent = map[rstate.choice] || "";
  }

  // Repaint just this section's consistency warnings (called live as the note or
  // the dropdown changes, without re-rendering the whole report).
  function renderReportWarnings(section, box, rstate) {
    const holder = box.querySelector(".r-warns");
    if (!holder) return;
    holder.innerHTML = "";
    sectionWarnings(section, rstate).forEach((msg) =>
      holder.append(el("p", { class: "r-warn" }, "⚠ ", msg)));
  }

  // One section was edited: repaint its warnings, then the header's roll-ups —
  // the warning count and the completeness summary both just moved. Cheap enough
  // for a keystroke; nothing here re-renders the report.
  function refreshSection(section, box, rstate) {
    renderReportWarnings(section, box, rstate);
    renderReportHeader();
    refreshSummaryCard(); // a statement change can move a marker on the summary card
  }

  // Tracks the operator's "I've reviewed this report section" progress — updated in
  // place (toggling the class + label on the existing nodes) so it never triggers a
  // full renderReport(), which on an image-heavy site would be needlessly expensive.
  function setSectionReviewed(sectionId, reviewed, box, label) {
    const rstate = state.report[sectionId] || (state.report[sectionId] = newReportState(sectionId));
    rstate.reviewed = !!reviewed;
    save();
    if (box) box.classList.toggle("is-reviewed", rstate.reviewed);
    if (label) {
      label.classList.toggle("on", rstate.reviewed);
      const span = label.querySelector("span");
      if (span) span.textContent = rstate.reviewed ? "✓ Section reviewed" : "Mark section reviewed";
    }
    renderReportHeader(); // the "n of 11 reviewed" roll-up moves with every tick
    if (focusLive()) renderFocus({ focus: false }); // a section step's "done" just moved
  }

  /* ============================================================== FOCUS MODE ===
     The split view above is a cockpit: everything reachable, nothing hidden, the
     operator in charge of what to look at next. That suits some people exactly.
     For others it is still overwhelming — not because of how much is on screen,
     but because they have to decide what to do next on every single screen.

     Focus mode is the second way to fly the same aircraft. One column, one step
     per screen, and the tool proposing the order. Two rules keep it from becoming
     a second application:

       ONE STATE, TWO PRESENTATIONS.  Every step reads and writes state.findings /
       state.report — the same objects, the same localStorage schema, the same
       ess-findings/1 export. Switching mode mid-assessment is a re-render and
       nothing else, and it is lossless in both directions (see setUiMode, which
       flushes any debounced keystroke before the DOM it was typed into goes away).

       NOTHING IS TRAPPED.  Focus PROPOSES an order; it never enforces one. Every
       step is reachable from the step list at any time, "Skip for now" is always
       available, and no step is a dead end.

     This section owns the shell, the step graph and every step body. Where a
     surface is too large or too specialised to have a Focus equivalent, the step
     hands off to the workbench with a labelled button (focusHandoffTo) — a route
     to the same controls rather than a dead end. ============================ */

  // ------------------------------------------------------------- the step graph
  // A pure function of state, computed on every render and NEVER stored. That is
  // what lets the flow reshape itself correctly the instant a card is re-routed to
  // a different section, an import answers fifteen sources at once, or the internal
  // -sources toggle changes which sources apply at all.
  //
  //   id     stable across recomputation ("src:qld-globe", "sec:invasive_plants").
  //          The cursor stores this, never an index — the list re-orders as work
  //          lands, and an index would silently point at a different step.
  //   phase  site · checks · sources · report · finish, for the chrome.
  //   kind   input (the operator supplies something) or output (the operator
  //          reviews something the tool assembled).
  //   ref    the source id or report-section id this step is about.
  //   state  done · needs-you · skipped · blocked · not-reached.
  const FOCUS_PHASE = { site: "Site", checks: "Checks", sources: "Sources", report: "Report", finish: "Finish" };

  // Has this source been answered AT ALL? This is the gate on a report section, and
  // deliberately not isOutstanding(): `manual` and `failed` are legitimate final
  // answers from the operator's point of view — a portal that must be visited in
  // person IS answered — and holding a report section hostage to a sign-off would
  // strand the flow on exactly the sources that can never be closed from a desk.
  //
  // "Still needs you" keeps its one definition (isOutstanding, above) and is what a
  // step's own state reports. The two saying different things about the same manual
  // source is the point, not a bug: the section is ready to write, and the source is
  // still on somebody's list.
  const hasAnswer = (f) => statusOf(f) !== STATUS.UNSET;

  // Steps waved past with "Skip for now". Session-only and per site: a skip is
  // "not now", not a decision about the assessment, and the cursor is the only
  // thing this mode persists.
  let focusSkipped = new Set();
  let focusCursor = null;   // the current step's stable id (persisted per site)
  let focusStepIds = [];    // ids of the last computed list — see resolveFocusCursor
  // The step to offer a way back to — see renderFocusReturn. An errand, not a
  // history: one slot, armed by a jump that starts on a section step and cleared
  // by the next navigation of any other kind.
  let focusReturn = null;
  // A different site is a different step list. Called wherever state.site is
  // reassigned, so one site's place can never be read as another's.
  function resetFocusCursor() {
    focusCursor = null; focusSkipped = new Set(); focusStepIds = []; focusReturn = null;
    // …and any offer that belonged to the site being left. The batch importer sets
    // this AFTER it has opened the first site, so its own offer survives.
    focusBatchOffer = 0;
  }

  function focusSteps() {
    const site = state.site;
    const steps = [];
    // `state` is settled in one pass at the end: a step's own facts decide
    // done/blocked/skipped, and only "have I got here yet" needs the cursor.
    const add = (id, phase, kind, title, extra) => steps.push(Object.assign(
      { id, phase, kind, title, ref: null, done: false, touched: false, state: "not-reached" }, extra || {}));

    add("site:pick", "site", "input", site ? "Change the site" : "Choose the site",
      { done: !!site, touched: !!site });
    // Nothing downstream is knowable without a site — which sources apply, and
    // therefore every other step, follows from where the site is.
    if (!site) { steps[0].state = "needs-you"; return steps; }

    // ackOnly: a step with no record of its own. The cursor is the only evidence
    // that the operator has been past it, so that is what marks it done. Walking
    // Back un-marks it, which is honest — there is nothing else to go on.
    add("site:details", "site", "input", "Check the station record and the date", { ackOnly: true });
    add("site:maps", "site", "input", "Check the locator maps", {
      // What this step is FOR is two maps of the right place, so it is finished when
      // both of them are actually there. A slot that failed stays "needs you", which
      // is honest, and blocks nothing: Continue never waits on the network.
      done: MAP_SLOTS.every((slot) => { const ms = state.maps[slot.key]; return !!(ms && ms.image); }),
    });
    add("site:photos", "site", "input", "Add any site photos", {
      // Photos are optional, so walking past this step is a legitimate answer to it
      // — but a site that already has some doesn't need walking past again.
      ackOnly: true,
      done: !!(state.siteImages || []).length,
      touched: !!(state.siteImages || []).length,
    });
    // The first proof the interleave works: the site has just been entered, checked
    // and photographed, and what the report now SAYS about it is shown immediately,
    // while it is still fresh — rather than three thousand pixels down another pane
    // an hour later.
    add("out:identity", "site", "output", "Review the report's front page", {
      ref: IDENTITY_SECTION,
      done: !!(state.report[IDENTITY_SECTION] || {}).reviewed,
    });
    add("checks:auto", "checks", "input", "Run the checks this tool can run itself",
      { done: !!state.flow.auto, touched: !!state.flow.auto });
    add("checks:prompt", "checks", "input", "Copy the prompt into an AI assistant",
      { done: !!state.flow.prompt, touched: !!state.flow.prompt });
    add("checks:paste", "checks", "input", "Paste the assistant's reply back",
      { done: !!state.flow.applied, touched: !!state.flow.applied });

    // ---- the interleave. Every card resolves to exactly ONE report section via
    // targetSectionOf(), so the order is a straightforward grouping: for each
    // report section, in proforma order, its sources and then the section itself.
    // The operator reviews each output while the evidence is still in their head,
    // and reaches the end with a finished report rather than a finished checklist.
    const bySection = new Map(REPORT_SECTIONS.map((sec) => [sec.id, []]));
    const orphans = [];
    sourcesForSite().forEach((src) => {
      const bucket = bySection.get(targetSectionOf(src));
      (bucket || orphans).push(src);
    });

    const addSourceStep = (src) => {
      const f = state.findings[src.id] || {};
      add(`src:${src.id}`, "sources", "input", src.name, {
        ref: src.id,
        // Settled: signed off, or answered and not outstanding. Either way there is
        // nothing left to ask of this source, and re-walking twelve of those is
        // exactly the volume complaint this mode exists to answer — forward
        // movement steps over them (focusMove) and the step list reaches them.
        done: isSignedOff(f) || !isOutstanding(f),
        // Anything recorded here — a status, a note, a photo — means somebody (or
        // an import) has already been at this source, wherever the cursor sits.
        touched: hasAnswer(f) || !!(f.note && f.note.trim()) || !!(f.images && f.images.length),
      });
    };

    REPORT_SECTIONS.forEach((sec) => {
      // Within a section, the existing dashboard ordering: what still needs a human
      // first, settled work last. sortCards sorts in place, so it gets a copy.
      const inSec = sortCards((bySection.get(sec.id) || []).slice());
      inSec.forEach(addSourceStep);
      const rstate = state.report[sec.id] || {};
      const gate = inSec.every((src) => hasAnswer(state.findings[src.id] || {}));
      add(`sec:${sec.id}`, "report", "output", sec.title, {
        ref: sec.id,
        sources: inSec.length,
        // A section with NO sources routed to it still gets a step, marked as such,
        // so the operator is told it was considered rather than finding it silently
        // absent. Its gate is vacuously open, so it never blocks progress.
        noSources: !inSec.length,
        gate,
        // The tick is recorded state and the graph never takes it back — but a
        // section whose gate has RE-OPENED (a source reset to Not checked after the
        // section was signed off) is not finished any more, so it stops counting as
        // done and says it needs another look. Nothing it holds is lost: statement,
        // note and tick are all still on the step when the operator returns to it.
        reviewed: !!rstate.reviewed,
        done: !!rstate.reviewed && gate,
      });
    });
    // A source whose category maps to no report section at all still has to be
    // worked — it just has no output to interleave with. Kept at the end of the
    // source work rather than dropped on the floor.
    orphans.forEach(addSourceStep);

    const counts = statusCounts();
    add("finish:export", "finish", "output", "Check what's left, and export", {
      gate: true,
      done: !counts.outstanding && REPORT_SECTIONS.every((sec) => (state.report[sec.id] || {}).reviewed),
    });

    // ---- settle the states.
    const at = steps.findIndex((s) => s.id === focusCursor);
    steps.forEach((s, i) => {
      if (focusSkipped.has(s.id) && !s.done) { s.state = "skipped"; return; }
      if (s.done) { s.state = "done"; return; }
      // An output is ready when its inputs are in, full stop — the gate opening is
      // the signal, and it does not wait for the cursor to arrive.
      if (s.kind === "output") { s.state = s.gate === false ? "blocked" : "needs-you"; return; }
      if (s.ackOnly) { s.state = i < at ? "done" : (i === at ? "needs-you" : "not-reached"); return; }
      // …and an input is "not reached" only while nothing has happened at it AND
      // the operator has not got there yet.
      s.state = (s.touched || at < 0 || i <= at) ? "needs-you" : "not-reached";
    });
    return steps;
  }

  // The cursor resolves by ID. When the step it names has gone — a card re-routed
  // to another section, internal sources hidden — land on the nearest EARLIER
  // survivor rather than throwing the operator back to the start, which is what the
  // previous list of ids is kept for. Not part of focusSteps(): that stays pure.
  function resolveFocusCursor(steps) {
    if (!steps.length) { focusStepIds = []; return -1; }
    let i = steps.findIndex((s) => s.id === focusCursor);
    if (i < 0) {
      for (let k = focusStepIds.indexOf(focusCursor) - 1; k >= 0 && i < 0; k--)
        i = steps.findIndex((s) => s.id === focusStepIds[k]);
      if (i < 0) i = 0;
      focusCursor = steps[i].id;
    }
    focusStepIds = steps.map((s) => s.id);
    return i;
  }

  // ------------------------------------------------------------ mode switching
  function readUiMode() {
    try { return localStorage.getItem(LS_MODE) === "workbench" ? "workbench" : "focus"; } catch (_) { return "focus"; }
  }

  // The label names where the button GOES, never where you are, so it always reads
  // as a way out. Making Focus the default only works if that is true on first sight.
  function syncModeButton() {
    const btn = $("#btn-mode");
    if (!btn) return;
    const out = focusLive();
    btn.textContent = out ? "Workbench ▸" : "Focus ▸";
    const label = out
      ? "Switch to the workbench — both panes, everything reachable at once"
      : "Switch to Focus mode — one step at a time, with the report interleaved";
    btn.title = label;
    btn.setAttribute("aria-label", label);
  }

  function detachWorkbench() {
    if (wbStash) return;
    wbStash = {};
    for (const id of WB_COLS) {
      const col = document.getElementById(id);
      if (!col) continue;
      const holder = document.createElement("div");
      holder.append(...Array.from(col.childNodes));
      wbStash[id] = holder;
    }
    // The two purely-derived regions are dropped rather than carried: a stashed
    // dashboard is still several hundred controls held in memory, and both are
    // rebuilt from state the moment the workbench comes back.
    ["#dashboard-groups", "#report-sections"].forEach((sel) => {
      const node = stashQuery(sel);
      if (node) node.replaceChildren();
    });
  }

  function attachWorkbench() {
    if (!wbStash) return;
    releaseAdoptedNodes();
    for (const id of WB_COLS) {
      const col = document.getElementById(id), holder = wbStash[id];
      if (col && holder) col.append(...Array.from(holder.childNodes));
    }
    wbStash = null;
  }

  // Workbench nodes borrowed INTO a Focus step body. The site picker is one: it is
  // already exactly the control that step needs, and re-parenting it keeps every
  // listener, so there is no second copy to keep in sync. Where each node came from
  // is recorded so the workbench is rebuilt intact.
  const adoptedNodes = [];
  function adoptNode(node, into) {
    if (!node || !into) return null;
    adoptedNodes.push({ node, parent: node.parentNode, next: node.nextSibling, hidden: node.hidden });
    node.hidden = false;
    into.append(node);
    return node;
  }
  function releaseAdoptedNodes() {
    while (adoptedNodes.length) {
      const a = adoptedNodes.pop();
      a.node.hidden = a.hidden;
      if (!a.parent) { a.node.remove(); continue; }
      if (a.next && a.next.parentNode === a.parent) a.parent.insertBefore(a.node, a.next);
      else a.parent.append(a.node);
    }
  }

  function setUiMode(mode, opts) {
    mode = mode === "workbench" ? "workbench" : "focus";
    const o = opts || {};
    // An in-flight debounced keystroke belongs to the state BOTH modes render, so
    // it is written before the DOM it was typed into goes away. This is the whole
    // of "switching loses nothing": there is no per-mode data to migrate.
    if (mode !== uiMode) flushSave();
    uiMode = mode;
    if (o.persist !== false) { try { localStorage.setItem(LS_MODE, uiMode); } catch (_) {} }
    syncModeButton();
    if (o.render === false) return;
    applyUiMode(o);
  }

  function applyUiMode(opts) {
    const split = $(".split"), region = $("#focus");
    if (focusLive()) {
      detachWorkbench();
      if (split) split.hidden = true;
      const shell = $("#mshell"); if (shell) shell.hidden = true;
      if (region) region.hidden = false;
      renderFocus(opts);
      // The pinned-box offsets the stylesheet reads belong to boxes that are no
      // longer on screen; re-measure so a stale --status-h / --mshell-h can't
      // offset a scroll in here.
      measureTopbar(); measureStatusBar(); measureReportHeader(); measureMobileShell();
      return;
    }
    releaseAdoptedNodes();
    if (region) { region.replaceChildren(); region.hidden = true; }
    attachWorkbench();
    if (split) split.hidden = false;
    if (state.site) renderWorkspace({ focus: false });
    else { renderRailNav(); renderMobileNav(); }
    measureTopbar(); measureStatusBar(); measureReportHeader(); measureMobileShell();
  }

  // ------------------------------------------------------------------ the shell
  // Identical on every step: where you are, the step's own one-line heading, the
  // body (which the step owns), and one primary action forward.
  let focusListOpen = false;

  function renderFocus(opts) {
    const root = $("#focus");
    if (!root || !focusLive()) return;
    const o = opts || {};
    const active = document.activeElement;
    const inStep = !!active && root.contains(active);
    // A BACKGROUND re-render — a result landing, a screenshot pasted in, an agent
    // writing a note — must not yank the caret out of a control the operator is
    // TYPING in. (The site picker's search box, the paste box, the correction
    // fields and a source step's own note are all reachable this way.)
    //
    // It must not cost them the render either. Skipping it is how a step whose own
    // state just moved ends up still saying "Needs you" under a box that was just
    // ticked — or, worse, how a pasted screenshot lands in state and nowhere on
    // screen, which reads as a paste that did nothing. So the caret is carried
    // across instead of being defended by standing still: ids are stable across
    // renders, and selection and scroll go with them.
    const typing = o.focus === false && inStep && isTypingControl(active);
    const caret = (typing && active.id) ? readCaret(active) : null;
    // Only when there is no id to find the control by again is the render skipped
    // — there would be nothing to put the caret back into. The next navigation
    // renders fresh anyway.
    if (typing && !caret) return;
    // The same handing-back for controls that are not typed in: a radio, a tick, a
    // dropzone that has just swallowed a photo.
    const refocusId = (o.focus === false && inStep && active.id) ? active.id : "";
    releaseAdoptedNodes(); // whatever the last render borrowed goes home first
    const steps = focusSteps();
    const at = resolveFocusCursor(steps);
    const step = steps[at];
    root.replaceChildren();
    if (!step) return;

    const done = steps.filter((s) => s.state === "done").length;
    // Every arrival lands focus on this heading, so its ACCESSIBLE NAME is the
    // whole of what a screen reader says about the new screen — and where you are
    // belongs in it. Hence the hidden prefix: the announcement reads "Step 14 of
    // 41 — Queensland Globe", one utterance, on the one event that means the
    // screen changed.
    //
    // Deliberately NOT an aria-live region. Live and focus together announce the
    // same step twice, and a live region on a node this mode re-renders on every
    // keystroke would read the step's name over the top of the operator's own
    // typing. Moving focus is already the announcement; nothing else has to fire.
    const heading = el("h2", { class: "fx-title", id: "fx-title", tabindex: "-1" },
      el("span", { class: "sr-only" }, `Step ${at + 1} of ${steps.length} — `),
      step.title);

    fxSpokenNow = new Set(); // …filled by whichever notices this render shows
    const chrome = renderFocusChrome(step, steps, at, done);
    root.append(
      el("div", { class: "fx-shell" },
        renderFocusIntro(),
        renderFocusBatchOffer(),
        renderFocusFlash(),
        chrome,
        renderFocusList(steps, at, chrome.querySelector("#fx-list-btn")),
        // `is-entering` is what the step transition hangs off, and it is set only
        // on a navigation. This shell is rebuilt on every background re-render —
        // every keystroke in a note — and a transition on those would flicker the
        // whole step under the operator's own typing. (Suppressed entirely under
        // prefers-reduced-motion; see the stylesheet.)
        el("div", { class: "fx-step" + (o.focus === false ? "" : " is-entering"),
          "data-kind": step.kind, "data-state": step.state },
          renderFocusReturn(step),
          el("p", { class: "fx-kicker" },
            el("span", { class: "fx-kind" }, step.kind === "output" ? "Review" : "Do"),
            el("span", { class: "fx-step-state", "data-state": step.state }, FOCUS_STATE_LABEL[step.state] || "")),
          heading,
          el("div", { class: "fx-body" }, focusStepBody(step))),
        renderFocusNav(step, steps, at)));
    fxSpokenPrev = fxSpokenNow;

    // ONE primary action per step. Continue is it on most of them — but a step
    // whose body carries its own filled button (the picker's Load site, the step-3
    // pass this step IS) has already got one, and two filled buttons side by side
    // is the action-hierarchy problem the panes were fixed for. The step's own
    // action wins; Continue steps back to "or move on". The borrowed button's own
    // classes are never touched — syncFlowSteps owns those, and the workbench wants
    // them back exactly as they were.
    // Only a primary the operator can actually SEE counts: the site picker carries
    // one on its coordinates tab, which is folded away while the name tab is open,
    // and demoting Continue for a button nobody can reach would leave the step with
    // no filled action at all.
    const next = root.querySelector("#fx-next");
    const ownPrimary = Array.from(root.querySelectorAll(".fx-body .btn.primary"))
      .some((n) => n.getClientRects().length);
    if (next && ownPrimary) {
      next.classList.remove("primary");
      next.classList.add("secondary");
    }

    afterFocusStep(step);

    // Moving to a step is a jump, and the heading is what it lands on — otherwise
    // the operator advances and their next Tab restarts from the top bar. `focus:
    // false` is for the renders that are a side effect of something else (a result
    // landing, a batch restoring on page load), which nobody asked to be moved by.
    if (o.focus !== false) { heading.focus({ preventScroll: true }); return; }
    const backId = caret ? caret.id : refocusId;
    if (!backId) return;
    const back = root.querySelector(`#${window.CSS && CSS.escape ? CSS.escape(backId) : backId}`);
    if (!back) return;
    back.focus({ preventScroll: true });
    if (caret) writeCaret(back, caret);
  }

  // Where the caret is, so it can be put back after the node it was in has been
  // rebuilt (or, for a borrowed node, re-parented — which blurs it either way).
  // selectionStart is not readable on every input type, so both directions are
  // guarded: losing the selection is a nuisance, throwing here would lose the render.
  function readCaret(n) {
    const c = { id: n.id, start: null, end: null, top: n.scrollTop };
    try { c.start = n.selectionStart; c.end = n.selectionEnd; } catch (_) {}
    return c;
  }
  function writeCaret(n, c) {
    if (c.start != null && n.setSelectionRange) {
      try { n.setSelectionRange(c.start, c.end); } catch (_) {}
    }
    n.scrollTop = c.top;
  }

  // Is this control one a person can be mid-keystroke in? Text inputs, textareas
  // and open selects are; buttons, ticks and radios are not.
  const NON_TYPING_INPUT = /^(checkbox|radio|button|submit|reset|file|image|range|color)$/i;
  function isTypingControl(n) {
    if (!n) return false;
    if (n.tagName === "TEXTAREA" || n.tagName === "SELECT") return true;
    return n.tagName === "INPUT" && !NON_TYPING_INPUT.test(n.type || "text");
  }

  // Work a step can only do once its body is actually IN the document. The map
  // sections are the case that needs it: renderSiteMap()/renderMapPresets() find
  // their figure with a document-rooted query, so they can only paint after the
  // borrowed #site-maps has been appended to the live tree.
  function afterFocusStep(step) {
    if (step.id !== "site:maps" || !state.site) return;
    renderMapsSections(); // rebuilds both sections, then paints each slot's current state
    // …and starts the ones that have never been tried. Deliberately not
    // ensureAllMaps(): a slot that FAILED must not be retried by the render that
    // the failure itself triggered, or the step would sit in a retry loop with a
    // spinner. A failed slot renders its own Retry button.
    MAP_SLOTS.forEach((slot) => { if (mapState(slot.key).status === "idle") ensureSiteMap(slot.key); });
  }

  // One sentence, shown once, at the top of the step the operator was just moved
  // to: what the thing they pressed on the LAST step actually did. Applying an
  // assistant's reply is the case it exists for — it answers a large part of the
  // list in one action, and landing silently on some unrelated step three phases
  // later would leave that unsaid.
  let focusFlash = null;
  function renderFocusFlash() {
    if (!focusFlash) return null;
    return el("p", { class: "fx-flash", role: fxLive(`flash:${focusFlash}`) }, focusFlash);
  }

  /* A live region announces itself whenever it APPEARS — and this shell is rebuilt
     from scratch on every background re-render, which in Focus means every
     keystroke in a note, every map that lands and every result an agent writes.
     A notice that merely persists across those renders is a brand new node in a
     brand new live region each time, so a screen reader reads it again on each
     one: "The assistant answered 19 of the 23 sources" over and over, under the
     operator's own typing.

     So a notice is live on the render that first shows it and inert on every
     render after, keyed by its content — a DIFFERENT flash is a different message
     and does get announced. Anything that stopped showing is dropped from the set,
     so a notice that comes back later is announced again, correctly. */
  let fxSpokenPrev = new Set(), fxSpokenNow = new Set();
  function fxLive(key) {
    fxSpokenNow.add(key);
    return fxSpokenPrev.has(key) ? null : "status";
  }

  const FOCUS_STATE_LABEL = {
    done: "Done", "needs-you": "Needs you", skipped: "Skipped",
    blocked: "Waiting on its sources", "not-reached": "Not started",
  };

  /* ----------------------------------------------------- the batch handoff
     The one surface that is genuinely NOT Focus-shaped. A batch is a way of
     working ACROSS sites — a tray of them, their states side by side, one
     consistency check over the lot — and Focus is a way of working THROUGH one.
     Building a Focus equivalent would mean a second navigation model inside a
     mode whose whole argument is that there is only one thing on screen.

     So it hands over, by the rule every handoff in this mode follows: a labelled,
     deliberate action that says what it opens and why. Never a silent mode flip
     — the batch has just loaded and the first site is open in Focus already, so
     declining is a real answer and costs nothing. Focus is still reachable per
     site from the tray, by the same top-bar button that got them here. */
  let focusBatchOffer = 0; // sites in the batch that just landed; 0 = no offer open
  function offerBatchHandoff(n) {
    if (!focusLive()) return;
    focusBatchOffer = n;
    // focus:false — the batch importer moved the operator to a new site already,
    // and this is a notice about that move rather than a second one.
    renderFocus({ focus: false });
  }
  function renderFocusBatchOffer() {
    const n = focusBatchOffer;
    if (!n) return null;
    return el("div", { class: "fx-handoff", role: fxLive(`batch:${n}`) },
      el("p", { class: "fx-handoff-lead" },
        `A batch of ${n} site${n === 1 ? "" : "s"} is loaded, and the first one is open here.`),
      el("p", { class: "fx-lede" },
        "Working across several sites — the tray of all of them, each one's state, and one consistency check over the lot "
        + "— is the workbench's job; Focus works through one site a step at a time. Both read the same saved work, and "
        + "Focus is one click away again from the top bar."),
      el("div", { class: "fx-actions" },
        el("button", {
          type: "button", class: "btn secondary",
          title: "Switches to the workbench and lands on the batch tray. Your work on this site is untouched.",
          onclick: () => { focusBatchOffer = 0; setUiMode("workbench"); jumpTo($("#batch-bar")); },
        }, "Open the batch in the workbench ▸"),
        el("button", {
          type: "button", class: "btn tertiary",
          title: "Stay on this step. The batch stays loaded, and the tray is in the workbench whenever you want it.",
          onclick: () => { focusBatchOffer = 0; renderFocus({ focus: false }); },
        }, "Stay in Focus")));
  }

  function renderFocusChrome(step, steps, at, done) {
    const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;
    return el("div", { class: "fx-chrome" },
      el("p", { class: "fx-where" },
        el("span", { class: "fx-phase", "data-phase": step.phase }, FOCUS_PHASE[step.phase] || ""),
        // No role="status" on either of these. The chrome is rebuilt by every
        // background re-render — a keystroke in a note, a map landing, an agent
        // writing a result — and as a live region it announced "Step 14 of 41"
        // over the top of each one. Arrival is announced once, by focus moving to
        // the heading, which is the only moment the step actually changed.
        el("span", { class: "fx-of" }, `Step ${at + 1} of ${steps.length}`),
        // Progress in words beside the bar. The bar is aria-hidden — it has no
        // accessible name to give and reads as nothing in greyscale — so the
        // number it draws is also said plainly, which is what a screen reader and
        // a greyscale screen both get.
        el("span", { class: "fx-done" }, `${done} done`)),
      el("span", { class: "cs-track fx-track", "aria-hidden": "true" },
        el("span", { class: "cs-fill", style: `width:${pct}%` })),
      el("button", {
        type: "button", class: "btn tertiary fx-list-btn", id: "fx-list-btn",
        "aria-expanded": focusListOpen ? "true" : "false", "aria-controls": "fx-list",
        title: "Every step, in order, with what each one still needs — and a jump to any of them",
        onclick: () => toggleFocusList(),
      }, `All steps ${focusListOpen ? "▴" : "▾"}`),
      // The shortcuts, where the movement they drive is described. Hidden on
      // narrow screens by the stylesheet — a phone has no Alt to press, and the
      // chrome there collapses to phase + n of m.
      el("p", { class: "fx-keys" },
        el("kbd", {}, "Alt"), el("span", { "aria-hidden": "true" }, "+"), el("kbd", {}, "→"),
        el("span", { class: "fx-keys-what" }, "continue"),
        el("kbd", {}, "Alt"), el("span", { "aria-hidden": "true" }, "+"), el("kbd", {}, "←"),
        el("span", { class: "fx-keys-what" }, "back")));
  }

  // Opening the step list puts the keyboard IN it, on the entry for where you are
  // — a menu that opens with focus left on its trigger has nothing for ↑/↓ to
  // walk, which makes it a mouse-only list with menu keys bolted on.
  function toggleFocusList(open) {
    focusListOpen = open === undefined ? !focusListOpen : !!open;
    renderFocus({ focus: false }); // …which puts focus back on the trigger
    if (!focusListOpen) return;
    const list = $("#fx-list");
    const here = list && (list.querySelector(".fx-list-item.is-here") || list.querySelector(".fx-list-item"));
    if (here) here.focus();
  }

  // Focus mode's answer to the nav rail, and what keeps "the tool proposes an
  // order, it does not impose one" true: every step, its state, and a jump.
  // `toggle` is handed in rather than looked up: this runs while the shell is
  // still being built, so the button it belongs to is not in the document yet.
  function renderFocusList(steps, at, toggle) {
    // A real menu, by the same contract the ⋯ menus keep: ↑/↓ walk it, Home/End
    // jump the ends, Esc closes and hands focus back to the trigger, Tab closes
    // because focus is leaving anyway. Forty-one entries is exactly the length at
    // which arrowing beats tabbing.
    const list = el("div", { class: "fx-list", id: "fx-list", role: "menu", "aria-label": "All steps" });
    list.hidden = !focusListOpen;
    if (!focusListOpen) return list;
    let phase = null, group = null, n = 0;
    steps.forEach((s, i) => {
      if (s.phase !== phase) {
        phase = s.phase;
        // role="group" with the phase heading as its label: a menu whose children
        // are anything other than menuitems is one a screen reader may flatten or
        // skip, and the phase names are worth keeping.
        const label = el("p", { class: "fx-list-phase", id: `fx-ph-${++n}` }, FOCUS_PHASE[phase] || phase);
        group = el("div", { class: "fx-list-group", role: "group", "aria-labelledby": label.id }, label);
        list.append(group);
      }
      const here = i === at;
      group.append(el("button", {
        // id: the list stays open across background re-renders — a map landing, an
        // agent writing a result — and each one rebuilds this button. Without an id
        // renderFocus has no way to hand focus back, so an operator arrowing down
        // the list at the moment a map resolved was dropped onto <body>.
        type: "button", role: "menuitem", id: `fxli-${s.id}`,
        class: "fx-list-item" + (here ? " is-here" : ""),
        "data-state": s.state, "aria-current": here ? "step" : null,
        // Selecting closes, as a menu does — and so the jump ends with focus on
        // the new step's heading rather than stranded in a list about a step the
        // operator has already left.
        onclick: () => { focusListOpen = false; focusGoTo(s.id); },
      },
        el("span", { class: "fx-list-mark", "aria-hidden": "true" }, FOCUS_STATE_MARK[s.state] || "·"),
        el("span", { class: "fx-list-name" }, s.title),
        el("span", { class: "fx-list-state" }, FOCUS_STATE_LABEL[s.state] || "")));
    });
    // Wired per render because the list is rebuilt per render — these are fresh
    // nodes every time, so there is nothing to accumulate listeners on.
    if (toggle) wireMenuKeys(toggle, list, (open) => toggleFocusList(open), ".fx-list-item");
    return list;
  }

  // Status is never carried by colour alone — see the same rule on the source
  // cards' status glyphs.
  const FOCUS_STATE_MARK = {
    done: "✓", "needs-you": "●", skipped: "↷", blocked: "⋯", "not-reached": "○",
  };

  // What Continue MEANS on this step, when it means more than "next".
  //
  // On a SOURCE it is the sign-off as well: the workbench's pill is one control
  // among twelve, and here the step's conclusion IS the judgement, so the label
  // says so — and says so only when there is an answer to sign off on.
  //
  // On a SECTION it is the review tick: same flag, same setter, same tally as the
  // workbench's checkbox. That is what makes the empty-section step honest — one
  // Continue, no controls to answer, and the section still ends up reviewed.
  //
  // `go` overrides where Continue lands, and only the return errand sets it.
  // Continue is never blocked: leaving a source unanswered and coming back to it is
  // legitimate, the step keeps saying it needs you, and Skip for now is the way
  // past on purpose.
  function focusContinue(step) {
    if (step.id.startsWith("sec:")) {
      if ((state.report[step.ref] || {}).reviewed) return null;
      return {
        label: "Mark reviewed and continue ▸",
        hint: "Records this section as reviewed in the report's own tally, then moves on",
        run: () => setSectionReviewed(step.ref, true),
      };
    }
    if (!step.id.startsWith("src:")) return null;
    const f = state.findings[step.ref] || {};
    const back = focusReturnSection();
    const sign = hasAnswer(f) && !isSignedOff(f);
    if (!sign && !back) return null;
    // On an errand, Continue is the way home — that is the whole of "go and check
    // one, then come back": one button, and it says where it goes.
    if (back) return {
      label: sign ? `Sign off and back to ${back.title} ▸` : `Back to ${back.title} ▸`,
      hint: sign
        ? `Records your sign-off on this source, then returns to the ${back.title} section`
        : `Returns to the ${back.title} section, where you came from`,
      run: () => { if (sign) setReviewed(step.ref, true); },
      go: () => focusGoTo(`sec:${back.id}`),
    };
    return {
      label: "Sign off and continue ▸",
      hint: "Records your sign-off on this source, then moves to the next step",
      run: () => setReviewed(step.ref, true),
    };
  }

  // The section a return errand leads back to, or null when none is armed.
  function focusReturnSection() {
    if (!focusReturn || !focusReturn.startsWith("sec:")) return null;
    return REPORT_SECTIONS.find((s) => s.id === focusReturn.slice(4)) || null;
  }

  // Offered at the head of the step an errand landed on. The caveat strip on a
  // section — "three of these sources were never checked" — is a prompt to go and
  // check one, and the whole value of that prompt is that coming back is one click
  // and lands where it left, with the section's state intact.
  function renderFocusReturn(step) {
    const back = focusReturnSection();
    if (!back || `sec:${back.id}` === step.id) return null;
    return el("p", { class: "fx-return" },
      el("span", { class: "fx-return-lead" }, "On an errand from"),
      el("button", { type: "button", class: "fx-return-btn",
        title: `Back to the ${back.title} section, exactly where you left it`,
        onclick: () => focusGoTo(`sec:${back.id}`) }, `◂ ${back.title}`));
  }

  function renderFocusNav(step, steps, at) {
    // Before a site is picked there is exactly one step, and Back / Skip / Continue
    // would each be a lie about somewhere to go. The step's own control is the way
    // forward, and it is the only primary action on the surface.
    if (steps.length < 2) return null;
    const last = at >= steps.length - 1;
    const cont = focusContinue(step);
    return el("div", { class: "fx-nav" },
      el("button", {
        type: "button", class: "btn tertiary", id: "fx-back", disabled: at <= 0 ? "disabled" : null,
        onclick: () => focusMove(-1),
      }, "◂ Back"),
      el("span", { class: "fx-nav-gap" }),
      // "Skip" means "leave this one, show me the next"; on the last step there is
      // no next for it to mean.
      last ? null : el("button", {
        type: "button", class: "btn tertiary", id: "fx-skip",
        title: "Leave this one for later — it stays on the step list and nothing is lost",
        onclick: () => { focusSkipped.add(step.id); focusMove(1); },
      }, "Skip for now"),
      el("button", {
        type: "button", class: "btn primary", id: "fx-next",
        title: cont && !last ? cont.hint : null,
        onclick: () => {
          if (last) return focusGoTo(steps[0].id);
          cont && cont.run();
          // …and only then the movement, so the step's own record is written
          // before the list it is about to be recomputed from.
          return cont && cont.go ? cont.go() : focusMove(1);
        },
      }, last ? "Back to the start" : (cont ? cont.label : "Continue ▸")));
  }

  // Making Focus the default changes the tool for people who were happy with it, so
  // the first Focus session says once — and only once — that the old view is one
  // click away. A browser flag, like the collection guide's: this is onboarding,
  // not chrome, and nobody should meet it twice.
  const LS_FOCUS_SEEN = LS_PREFIX + "focus-seen";
  function focusIntroSeen() { try { return localStorage.getItem(LS_FOCUS_SEEN) === "1"; } catch (_) { return true; } }
  function renderFocusIntro() {
    if (focusIntroSeen()) return null;
    return el("p", { class: "fx-intro", role: fxLive("intro") },
      el("span", {},
        "This is ", el("b", {}, "Focus"), " — one step at a time, with the report built into the flow. ",
        "The full workbench is one click away, top right, whenever you want it."),
      el("button", {
        type: "button", class: "btn tertiary tiny",
        onclick: () => {
          try { localStorage.setItem(LS_FOCUS_SEEN, "1"); } catch (_) {}
          renderFocus({ focus: false });
        },
      }, "Got it"));
  }

  // `flash` is the one-sentence receipt to carry ONTO the step being moved to.
  // Every ordinary navigation passes nothing, which is what clears a stale one:
  // the message belongs to the move that produced it and to no other.
  //
  // `opts.returnTo` is the same idea for the way BACK: an errand out of a section
  // step arms it, every other navigation clears it, so the offer to return can
  // never outlive the errand that made it.
  function focusGoTo(id, flash, opts) {
    focusCursor = id;
    focusFlash = flash || null;
    focusReturn = (opts && opts.returnTo) || null;
    // A discrete choice, and often the last thing done before a reload — persist it
    // now rather than 400 ms later.
    save(); flushSave();
    renderFocus();
  }
  // A source with nothing left to ask of it. The last step is never one (it is the
  // finish step), so the walk below always terminates on something worth arriving at.
  const isSettledSource = (s) => s.id.startsWith("src:") && s.state === "done";

  // Forward movement steps OVER settled sources; Back never does.
  //
  // Twelve of a typical site's sources come back settled from the automated round
  // trip, and presenting each of them as a screen that asks nothing is the volume
  // this mode exists to answer. Back is the retracing motion, though — and by the
  // time it is pressed, Continue has usually just SETTLED the source it would be
  // retracing to — so it moves one step at a time and can always reach the step
  // just left. Anything either of them passes is one click away in the step list.
  function focusMove(delta) {
    const steps = focusSteps();
    const at = resolveFocusCursor(steps);
    let next = Math.max(0, Math.min(steps.length - 1, at + delta));
    if (delta > 0) while (next < steps.length - 1 && isSettledSource(steps[next])) next++;
    focusGoTo(steps[next].id);
  }

  /* --------------------------------------------------------------- the shortcuts
     Documented on the step chrome, because a shortcut nobody is told about is not
     an accessibility feature.

     Alt is the modifier, and the choice is forced: this surface is full of
     textareas, selects and a four-way radiogroup, so a bare arrow belongs to the
     caret and to the roving tabindex, and Enter belongs to whatever control has
     focus. Neither can be taken from them.

     The keys press the buttons rather than reimplementing them, so Alt+→ cannot
     drift from what Continue does — the sign-off it records, the errand it
     returns from, the wrap-around on the last step all come along for free, and a
     disabled Back is simply never pressed. */
  const DIALOGS = ".qm-overlay, .bb-overlay, .rp-overlay, .lb-overlay";
  // Is one of the app's four modals up? Each conceals itself differently — a
  // `hidden` attribute, a .show class, or both — so the question is asked of the
  // layout instead of any one of those flags. Same test trapFocus uses.
  const dialogOpen = () => $$(DIALOGS).some((n) => n.getClientRects().length);

  function wireFocusKeys() {
    document.addEventListener("keydown", (e) => {
      if (!focusLive() || e.defaultPrevented) return;
      // A modal is its own world, with its own Escape and its own Tab trap.
      // Moving the step underneath one would strand the operator in a dialog
      // belonging to a step they are no longer on.
      if (dialogOpen()) return;
      if (e.key === "Escape") {
        if (!focusListOpen) return;
        e.preventDefault();
        // Focus is left exactly where it is. Escape from INSIDE the list is
        // wireMenuKeys' — it stops propagation before this runs, and hands focus
        // back to the trigger. This branch is the other case, where the list is
        // merely open and the operator is typing somewhere else entirely.
        toggleFocusList(false);
        return;
      }
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const btn = $(e.key === "ArrowRight" ? "#fx-next" : "#fx-back");
      if (!btn || btn.disabled) return;
      e.preventDefault();
      btn.click(); // …which navigates, which moves focus to the new step's heading
    });
  }

  // ------------------------------------------------------------- the step bodies
  // Every step id in the graph resolves to a body now. The lede-plus-handoff
  // fallback at the foot of focusStepBody stays as the safety net for a step id
  // that ever gets added without one: a labelled route to the same controls in the
  // workbench, rather than a screen that says nothing.
  const FOCUS_LEDE = {
    "site:details": "Filled in from the Bureau station list. Read it back — it is usually right — then set the date this assessment was made.",
    "site:maps": "Two satellite locators are stitched for every site: the close surrounds, and the region around them. Check they show the place you mean.",
    // Leads with the gesture every device has. Ctrl+V and drag-and-drop are named
    // second and qualified, because on the phone this step is read on they do not
    // exist — and an instruction that opens with one of them reads as "you cannot
    // do this here".
    "site:photos": "Optional. Take a photo or choose one from this device — or, at a desktop, paste a screenshot with Ctrl+V or drag an image in. They carry through to the report. Continue past this if you have none.",
    "out:identity": "The front page of the deliverable, as it now reads. Nothing further is asked of you here — check it says the right site, and tick it off.",
    "checks:auto": "Queries every source with a public data API (Atlas of Living Australia, WildNet…) straight from your browser.",
    "checks:prompt": "One self-contained prompt for this site — paste it into ChatGPT, Gemini, Claude or Copilot and let it research the rest.",
    "checks:paste": "The assistant answers with one JSON object. Anything it leaves blank keeps the result you already have.",
    "finish:export": "What is still outstanding, and every way this report leaves the app.",
  };

  function focusStepBody(step) {
    if (step.id === "site:pick") {
      // The picker IS this step. Borrowed rather than rebuilt, so the autocomplete,
      // the coordinate tab and every listener on them are the same ones.
      const box = el("div", { class: "fx-adopt" });
      adoptNode($("#site-picker"), box);
      return box;
    }
    const body = el("div", {});
    if (step.id.startsWith("src:")) return focusSourceBody(step, body);
    if (step.id.startsWith("sec:")) return focusSectionBody(step, body);
    const own = FOCUS_BODY[step.id];
    if (own) return own(step, body);
    const lede = FOCUS_LEDE[step.id];
    if (lede) body.append(el("p", { class: "fx-lede" }, lede));
    body.append(focusHandoffBtn(step, "Open this in the workbench"));
    return body;
  }

  /* --------------------------------------------------- site · details · identity
     The opening run of steps, and the first interleaved output. Every one of them
     borrows the workbench control that already does the job rather than growing a
     second copy of it: the correction disclosure, the two map sections, the photo
     dropzone and the three step-3 actions are all the SAME nodes, re-parented for
     as long as the step is on screen and put back by releaseAdoptedNodes(). That
     is what makes "a run in Focus shows as done in the workbench" true by
     construction rather than by a synchronisation routine. */

  // The station record, read back rather than typed. Auto-filled from the Bureau
  // station list and right nearly every time, so this is a confirmation with one
  // correction affordance behind it — not six input boxes asking to be re-entered.
  function focusDetailsBody(step, body) {
    body.append(el("p", { class: "fx-lede" }, FOCUS_LEDE["site:details"]));
    const dl = el("dl", { class: "fx-record" });
    stationRecordRows().forEach(([k, v]) => dl.append(
      el("div", { class: "fx-record-row" }, el("dt", {}, k), el("dd", {}, String(v == null ? "—" : v)))));
    if (state.site && state.site.manual)
      dl.append(el("div", { class: "fx-record-row" }, el("dt", {}, "Source"), el("dd", {}, "Manual coordinate entry")));
    body.append(dl);
    // One affordance, shut by default — the whole point of the read-back above is
    // that correcting it is the exception.
    const correct = el("div", { class: "fx-adopt" });
    adoptNode($("#sd-correct"), correct);
    body.append(correct);
    // …and the two fields that ARE routinely typed here.
    const fields = el("div", { class: "fx-adopt" });
    adoptNode($(".summary-editable"), fields);
    body.append(fields);
    return body;
  }

  // Both locator maps, arriving. The map sections are borrowed whole, so the size
  // presets, the roads/labels toggle and Refresh are the controls the workbench
  // has — but they start folded away: at rest this step asks one question ("is
  // this the right place?") and two pictures answer it. Ten preset buttons on
  // screen to ask that would be the wrong step.
  function focusMapsBody(step, body) {
    body.append(el("p", { class: "fx-lede" }, FOCUS_LEDE["site:maps"]));
    const maps = el("div", { class: "fx-adopt fx-maps" });
    adoptNode($("#site-maps"), maps);
    const tune = el("button", {
      type: "button", class: "btn tertiary", "aria-expanded": "false", "aria-controls": "site-maps",
      title: "Change how far across each map is, and whether roads and place names are drawn on it",
      onclick: (e) => {
        const on = maps.classList.toggle("is-tuning");
        e.currentTarget.setAttribute("aria-expanded", on ? "true" : "false");
        e.currentTarget.textContent = on ? "Hide the map controls ▴" : "Size, labels and refresh ▾";
      },
    }, "Size, labels and refresh ▾");
    body.append(maps, el("div", { class: "fx-actions" }, tune));
    return body;
  }

  // Paste, drag, or choose a file — the same zone the workbench uses, so a
  // Ctrl+V anywhere on this step lands here exactly as it does over there (the
  // document-level listener in wireSiteDetails is what catches the ones the zone
  // itself doesn't).
  function focusPhotosBody(step, body) {
    body.append(el("p", { class: "fx-lede" }, FOCUS_LEDE["site:photos"]));
    const zone = el("div", { class: "fx-adopt" });
    adoptNode($(".photo-section"), zone);
    body.append(zone);
    return body;
  }

  // The first output. Not a summary of the front page — the front page: the
  // document header's own words, the real locator maps, the real photographs, and
  // the same Reviewed tick the report pane carries, writing the same state.
  function focusIdentityBody(step, body) {
    const idt = reportIdentityText();
    body.append(el("p", { class: "fx-lede" }, FOCUS_LEDE["out:identity"]));
    const head = el("div", { class: "fx-rdoc" },
      el("p", { class: "fx-rdoc-kicker" }, "Environmental Site Summary"),
      el("h3", { class: "fx-rdoc-name" }, idt.name),
      el("p", { class: "fx-rdoc-ids" }, idt.ids));
    // Folded, because the document header folds it: what tells two open sites
    // apart is the line above, and the rest of the record is a disclosure over
    // there too (#rdoc-detail is `hidden` until Details ▾ is pressed).
    const dl = el("dl", { class: "fx-record fx-rdoc-detail" });
    idt.detail.forEach(([k, v]) => dl.append(
      el("div", { class: "fx-record-row" }, el("dt", {}, k), el("dd", {}, v))));
    head.append(el("details", { class: "fx-rdoc-more" },
      el("summary", {}, "The rest of the record"), dl));
    body.append(head);

    const maps = reportMapsBlock(), photos = reportPhotosBlock();
    if (maps) body.append(maps);
    // The same card the report pane's front page carries, from the same rollup —
    // this step IS the front page, so it cannot be missing the summary that page has.
    const summary = reportSummaryBlock();
    if (summary) body.append(summary);
    if (photos) body.append(photos);
    if (!maps) body.append(el("p", { class: "fx-lede" },
      MAP_SLOTS.some((slot) => (state.maps[slot.key] || {}).status === "loading")
        ? "The locator maps are still being stitched — they will appear here as they arrive."
        : "No locator map has been generated yet. Go back a step to retry it."));

    // The tick and the way in to change any of it, on one row — they are the two
    // answers to the same question ("does this front page read right?"), and a
    // second row for the second answer is a row this step cannot spare.
    body.append(el("div", { class: "fx-actions fx-review" },
      identityReviewToggle(null, "fx-identity-reviewed"),
      el("button", { type: "button", class: "btn secondary", onclick: () => focusHandoffTo(step) },
        "Open this in the report pane ▸")));
    return body;
  }

  /* ---------------------------------------------------- the automated round trip
     Three steps, one sequence — and it already knows it is one. state.flow /
     syncFlowSteps / markFlowDone record each pass and its one-line receipt, per
     site, which is exactly what a Focus step needs, so nothing here invents a
     second done-tracker: the workbench's receipts ARE these steps' done summaries,
     and a run in either mode shows as run in the other. */
  const FLOW_OF_STEP = { "checks:auto": "auto", "checks:prompt": "prompt", "checks:paste": "applied" };
  const CHECKS_STEPS = Object.keys(FLOW_OF_STEP);

  function focusChecksBody(step, body) {
    const key = FLOW_OF_STEP[step.id];
    const flow = state.flow || (state.flow = freshFlow());
    body.append(el("p", { class: "fx-lede" }, FOCUS_LEDE[step.id]));
    // What this pass did, last time it ran — the workbench's receipt, verbatim.
    if (flow[key]) body.append(el("p", { class: "fx-receipt" },
      el("b", {}, "✓ "), flow.notes[key] || FLOW_STEPS.find((f) => f.key === key).done));
    // The action itself, borrowed: the button, its status line and (on the paste
    // step) the textarea are the workbench's own, wiring included.
    const doBox = el("div", { class: "fx-adopt fx-flow-do" });
    adoptNode($(`.flow-step[data-flow="${key}"] .flow-do`), doBox);
    body.append(doBox);
    // A user working entirely by hand should be able to pass the whole assistant
    // round trip in one action rather than three.
    body.append(el("div", { class: "fx-actions" },
      el("button", {
        type: "button", class: "btn tertiary",
        title: "Leave all three of the automated passes — you can come back to any of them from the step list",
        onclick: () => {
          CHECKS_STEPS.forEach((id) => focusSkipped.add(id));
          const steps = focusSteps();
          const after = steps.findIndex((s) => s.id === "checks:paste");
          focusGoTo((steps[after + 1] || steps[steps.length - 1]).id);
        },
      }, "Skip all three ▸")));
    // …and the other way past all three: the BYOK agent, offered on the first of
    // them because it is an alternative to the whole sequence, not an extra pass.
    if (step.id === "checks:auto") body.append(focusAgentHatch());
    return body;
  }

  /* ------------------------------------------------ the BYOK agent, from Focus
     `assets/agent.js` writes through the same narrow `window.ESS` seam every
     other route into state uses, so a live run needs no Focus-specific plumbing
     at all: `setResult` calls `refreshCard`, which in Focus re-renders the step,
     and the step graph is recomputed from state on every one of those — so the
     flow reshapes itself under the operator as the answers land.

     What this adds is the offer and the landing. The panel is the workbench's
     own node, borrowed (key field, model picker, Run and its status line), so
     there is no second copy of a control that holds an API key. Shut by default:
     an assessment that is going to be worked by hand should not be met by a
     request for a credential. */
  let focusAgentOpen = false;
  // How many sources the agent run in flight has recorded. Reset by ESS.beginRun,
  // counted by ESS.setResult, read by ESS.endRun — which is the only way to tell a
  // run that did the work from one that failed on its first turn, since endRun
  // fires from agent.js's `finally` either way.
  let agentRunWrote = 0;
  function focusAgentHatch() {
    // agent.js is optional — index.html ships the empty panel and the button that
    // opens it, and the module unhides that button when it activates. No module,
    // no offer, rather than a control that does nothing.
    const settings = $("#btn-agent-settings"), panel = $("#agent-panel");
    if (!settings || settings.hidden || !panel) return null;
    const box = el("div", { class: "fx-hatch" });
    box.append(el("div", { class: "fx-actions" }, el("button", {
      type: "button", class: "btn tertiary",
      "aria-expanded": focusAgentOpen ? "true" : "false", "aria-controls": "agent-panel",
      title: "Claude works through every source itself using your own Anthropic API key, instead of the copy-prompt round trip. The key stays in this browser.",
      onclick: () => { focusAgentOpen = !focusAgentOpen; renderFocus({ focus: false }); },
    }, focusAgentOpen ? "Hide the Claude runner ▴" : "Or have Claude run every source ▾")));
    if (focusAgentOpen) {
      const holder = el("div", { class: "fx-adopt fx-agent" });
      adoptNode(panel, holder);
      // The panel carries its own Close, which hides it. In the workbench that is
      // the whole gesture; here it would leave an open disclosure over nothing, so
      // the disclosure follows it shut. A bubbling listener, so it runs after
      // agent.js's own handler has done the hiding — and no change to agent.js,
      // which is the point of the seam.
      holder.addEventListener("click", () => {
        if (!panel.hidden) return;
        focusAgentOpen = false;
        renderFocus({ focus: false });
      });
      box.append(holder);
    }
    return box;
  }

  // Where a finished agent run leaves the operator. The run answers a large part
  // of the list in one action and reshapes the flow doing it, so landing silently
  // on whatever step was open when it started would leave that unsaid — this is
  // the same contract as focusAfterApply, for the other route to the same result.
  function focusAfterRun(wrote) {
    const c = statusCounts();
    const said = [
      wrote ? `${wrote} source${wrote === 1 ? "" : "s"} answered` : "Run finished",
      c.outstanding ? `${c.outstanding} still need${c.outstanding === 1 ? "s" : ""} you` : "nothing left outstanding",
    ].join(" · ");
    const steps = focusSteps();
    // The first step that still wants a human: a source if there is one, else the
    // first output waiting to be reviewed, else the finish step. Never a dead end.
    const target = steps.find((s) => s.id.startsWith("src:") && s.state === "needs-you")
      || steps.find((s) => s.kind === "output" && s.state === "needs-you")
      || steps[steps.length - 1];
    focusGoTo(target.id, `✓ Claude's run finished — ${said}.`);
  }

  // Where an applied reply leaves the operator, and what it tells them on arrival.
  // The count comes from the same statusCounts() the collection bar reads, so the
  // sentence here and the number over there can never disagree.
  function focusAfterApply(answered) {
    const left = statusCounts().outstanding;
    const said = [
      answered ? `${answered} source${answered === 1 ? "" : "s"} answered` : "Reply applied",
      left ? `${left} still need${left === 1 ? "s" : ""} you` : "nothing left outstanding",
    ].join(" · ");
    const steps = focusSteps();
    // The first source step that still needs a human. Falling back to the step
    // after the paste step keeps this from ever being a dead end on a site the
    // reply answered outright.
    const target = steps.find((s) => s.id.startsWith("src:") && s.state === "needs-you")
      || steps[steps.findIndex((s) => s.id === "checks:paste") + 1]
      || steps[steps.length - 1];
    focusGoTo(target.id, `✓ ${said}.`);
  }

  const FOCUS_BODY = {
    "site:details": focusDetailsBody,
    "site:maps": focusMapsBody,
    "site:photos": focusPhotosBody,
    "out:identity": focusIdentityBody,
    "checks:auto": focusChecksBody,
    "checks:prompt": focusChecksBody,
    "checks:paste": focusChecksBody,
    "finish:export": focusFinishBody,
  };

  /* -------------------------------------------------------------- a source step
     The headline step, and where most of an assessment is spent: one source,
     alone on the screen, asking the one question that source exists to answer.

     The workbench card already sequences this correctly — identity → what came
     back → your answer → evidence → into the report → done — so that order stays,
     and every control on it is the workbench's own renderer writing the same
     state. There is no second implementation of anything here, which is what
     makes "a source answered in Focus is answered in the workbench, and the other
     way round" true by construction.

     What changes is that the card IS the screen, so the things that had to be
     folded away to fit 23 cards in a column are open by default: the instruction
     (the ⓘ disclosure), the whole of the result text (the four-line clamp), and
     the evidence zone once the result is Found. The ⋯ stays a ⋯ — those really
     are occasional — and the sign-off pill becomes the step's Continue. */
  function focusSourceBody(step, body) {
    const src = DATA.sources.find((s) => s.id === step.ref);
    if (!src) {
      body.append(el("p", { class: "fx-lede" },
        "This source is no longer in the registry — nothing is asked of you here."));
      return body;
    }
    const f = state.findings[src.id] || (state.findings[src.id] =
      { status: STATUS.UNSET, note: "", result: null, images: [], reviewed: false });
    if (!f.images) f.images = [];
    body.classList.add("fx-source");

    // The note is built first because the ⋯ menu's "Clear my note" needs it; it is
    // appended in its own zone further down.
    const note = el("textarea", {
      class: "note-field", id: `fx-note-${src.id}`, rows: "1",
      "aria-label": `Your note on ${src.name}`,
      placeholder: "Your own words for the report…",
      oninput: (e) => { f.note = e.target.value; save(); autoGrow(e.target); },
      onchange: () => { renderReport(); },
    });
    note.value = f.note || "";

    // ---- 1. which source, and why -----------------------------------------
    // Open, not behind ⓘ. On the card this is reference prose repeated 23 times
    // down a column and it earns a disclosure; here it is the instruction for the
    // step, and the operator who most needs it is the one who would never think
    // to open a disclosure to find it.
    body.append(el("p", { class: "fx-facts" },
      el("span", { class: "tag jur" }, src.jurisdiction === "national" ? "National" : (state.site.state || "State")),
      src.method === "api"
        ? el("span", { class: "tag api" }, "Queried by API")
        : el("span", { class: "tag method" }, "Checked by hand"),
      src.internal ? el("span", { class: "tag internal" }, "Internal — BOM staff only") : null,
      // Sign-off is normally recorded BY Continue, so the only time it needs
      // stating is when it has already happened and the step is being revisited.
      isSignedOff(f) ? el("span", { class: "fx-fact" }, "✓ Signed off") : null));
    if (src.what_to_find)
      body.append(el("p", { class: "fx-lede" }, el("b", {}, "What to look for: "), src.what_to_find));
    if (src.instructions)
      body.append(el("p", { class: "fx-lede" }, el("b", {}, "How to run it: "), src.instructions));

    // ---- 2. open the source -----------------------------------------------
    // The whole point of the step, and its one filled button. Same handler the
    // card's primary carries: the click copies the coordinates on the way out, so
    // the source's own search box can be filled by paste.
    const tools = el("div", { class: "fx-actions" });
    const url = buildUrl(src);
    if (url) tools.append(el("a", {
      class: "btn primary", href: url, target: "_blank", rel: "noopener",
      onclick: () => copy(`${state.site.lat}, ${state.site.lon}`, "Coordinates copied"),
    }, "Open the source ↗"));
    // The specialist tools stay on their own source, where they belong — each
    // opens the workbench's own handler, from here, with no trip through the
    // other mode. They are alternatives to "go and look", never a second filled
    // button competing with it.
    // id: capturing a map writes a finding, which repaints this step while the
    // map is still open — so the button that opened it has to be findable again
    // by the time the map closes and hands focus back. See restoreFocusAfterDialog.
    if (src.id === "qld-globe" && state.site.state === "QLD")
      tools.append(el("button", { type: "button", class: "btn secondary", id: "fx-open-qldmap",
        onclick: () => openQldGlobeMap(src) }, "Open site map"));
    const runner = apiRunnerFor(src);
    // id: the runner paints its progress into #run-… / #res-… by document lookup.
    // Only one mode's copy of those ids is ever in the document — the workbench's
    // dashboard is dropped while Focus is live — so they cannot collide.
    if (runner) tools.append(el("button", { type: "button", class: "btn secondary",
      id: `run-${src.id}`, onclick: () => runner(src) }, "Check live"));
    if (src.xlsx_import === "pmst_mnes") {
      const fileInput = el("input", {
        type: "file", accept: ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", hidden: true,
        onchange: (e) => { const file = e.target.files && e.target.files[0]; if (file) importPmstXlsx(src.id, file, importBtn); e.target.value = ""; },
      });
      const importBtn = el("button", { type: "button", class: "btn secondary",
        onclick: () => fileInput.click() }, "Import PMST Excel");
      tools.append(importBtn, fileInput);
    }
    tools.append(renderCardMenu(src, note, { handoff: step }));
    body.append(tools);

    // ---- 3. what came back -------------------------------------------------
    // In full. The four-line clamp exists because 23 cards share one column; here
    // there is one, and a truncated finding is the operator reading half of what
    // the machine actually found. A source nobody has run has none of this, and
    // the step then reads as "go and look" — which is exactly what it is.
    const resultPanel = el("div", { class: "src-result", id: `res-${src.id}` });
    if (f.result) paintResult(resultPanel, f.result.html, { status: f.status, err: f.result.err });
    body.append(resultPanel);

    // ---- 4. your answer ----------------------------------------------------
    // Stated once, and always open: on a screen of its own the answer IS the
    // question, and a Manual or Failed source collapsing to a chip would ask for a
    // click before it could be changed.
    const hint = el("p", { class: "do-hint", id: `fx-hint-${src.id}`, hidden: true },
      "Found ≠ good news — a protected species means caution on site. Signing off is your judgement about this source, tracked separately from the result.");
    const lead = el("button", {
      type: "button", class: "do-lead do-lead-info", "aria-expanded": "false", "aria-controls": hint.id,
      title: "What Result means, and how it relates to signing off",
      onclick: () => {
        const open = hint.hidden;
        hint.hidden = !open;
        lead.setAttribute("aria-expanded", open ? "true" : "false");
        lead.classList.toggle("on", open);
      },
    }, "Result", el("span", { class: "do-lead-mark", "aria-hidden": "true" }, "ⓘ"));
    body.append(el("div", { class: "fx-answer" },
      el("div", { class: "do-row" }, lead, renderStatusControl(src, f, { open: true })),
      hint));

    // ---- 5. your note ------------------------------------------------------
    body.append(el("div", { class: "src-note" },
      el("div", { class: "note-head" }, el("span", { class: "zone-label" }, "Your note")),
      note));

    // ---- 6. evidence -------------------------------------------------------
    // Revealed when the result is Found, which is when evidence is wanted — the
    // same set the card opens, so a zone opened in either mode is open in both.
    // Everything in it is renderPhotoBlock's: the drop/paste/pick zone and, on
    // species cards, both Wikipedia reference-image controls.
    if (PHOTO_CATEGORIES.has(src.category)) {
      if (f.status === STATUS.FOUND) CARD_OPEN.photos.add(src.id);
      const photos = renderPhotoBlock(src, f);
      body.append(el("div", { class: "fx-evidence" },
        el("div", { class: "note-head" },
          el("span", { class: "zone-label" }, "Evidence"), photos.addBtn),
        photos.body));
    }

    // ---- 7. where it goes --------------------------------------------------
    // Quieter here than on the card, and without the sign-off pill: the default
    // routing is right nearly always, and this section is a few steps away, where
    // a mistake in it is obvious and correctable.
    body.append(renderIncludeRow(src, { signoff: false }));
    // The note can only be sized once it is laid out; the batched frame this
    // queues runs after the step has been appended to the document.
    queueCardMetrics();
    return body;
  }

  // The source a stray Ctrl+V belongs to. In Focus a source step IS the screen, so
  // a screenshot pasted anywhere on it is that source's evidence rather than a
  // station photo. The evidence zone's own listener still claims the pastes made
  // into it (and calls preventDefault); this only names where the rest should go.
  function focusPasteSourceId() {
    if (!focusLive() || !focusCursor || !focusCursor.startsWith("src:")) return null;
    const id = focusCursor.slice(4);
    const src = DATA.sources.find((s) => s.id === id);
    return src && PHOTO_CATEGORIES.has(src.category) ? id : null;
  }

  /* ------------------------------------------------------- a report section step
     The half of this mode that makes it more than a wizard. The operator has just
     worked through every source routed to this section; the evidence is still in
     their head. This step asks the one question that is worth asking at exactly
     that moment: HERE IS WHAT THE REPORT NOW SAYS ABOUT INVASIVE PLANTS — IS THAT
     RIGHT?

     Five things, in the order a person answers them:

       1  what this section concludes   the standardized statement
       2  ⚠ anything inconsistent       sectionWarnings, at the moment it can be acted on
       3  the detail                    the free-text note, with a draft on offer
       4  what it rests on              the evidence, split three ways (#49)
       5  reviewed ✓                    the section's own tick, which is Continue

     Item 2 is why the step exists. In the workbench those warnings sit in the
     right pane, where an operator concentrating on collection may never look; here
     they are on the screen at the moment the operator is deciding, which is the
     only moment they can act on. (They still never reach the exported artefact.)

     Every control is the report pane's own renderer writing the same state through
     the same helpers — suggestChoice, sectionNarrative, sectionWarnings,
     syncBioDetail, renderSectionEvidence, setSectionReviewed — so a section written
     in Focus IS the section the report shows, by construction. `body` doubles as
     the `box` those helpers take: it holds this section's .r-warns and #bio-detail,
     and only one mode's copy of either is ever in the document. */
  function focusSectionBody(step, body) {
    const section = REPORT_SECTIONS.find((s) => s.id === step.ref);
    if (!section) {
      body.append(el("p", { class: "fx-lede" },
        "This section is no longer in the proforma — nothing is asked of you here."));
      return body;
    }
    ensureReportChoices(); // the auto-suggested statement, on the mode that has no report pane
    const rstate = state.report[section.id] || (state.report[section.id] = newReportState(section.id));
    body.classList.add("fx-section");

    // A section nothing feeds: one screen, one sentence, and Continue records the
    // review. Being told a section was considered and found irrelevant is worth a
    // screen; a blank form asking nothing is not.
    if (step.noSources) {
      body.append(el("p", { class: "fx-lede" },
        `No source that applies to this site feeds ${section.title}. It was considered — nothing is needed from you here, and Continue marks it reviewed.`));
      body.append(el("div", { class: "fx-actions fx-review" },
        sectionReviewToggle(section.id, { box: body, inputId: `fx-sec-rev-${section.id}` })));
      return body;
    }

    // ---- 0. the gate, when it is not shut behind us -------------------------
    // Reachable early (the step list never traps anything) and reachable AGAIN
    // after a source is reset to Not checked. Both cases say what is outstanding
    // and offer the errand; neither hides the work already recorded below.
    if (!step.gate) {
      const waiting = sourcesForSite().filter((s) =>
        targetSectionOf(s) === step.ref && !hasAnswer(state.findings[s.id] || {}));
      const n = waiting.length;
      body.append(el("div", { class: "fx-reopen" },
        el("p", { class: "fx-reopen-lead" }, step.reviewed
          ? `You reviewed this section, and ${n} of its sources ${n === 1 ? "has" : "have"} gone back to Not checked since. Your statement, note and tick are all still here — it needs another look, not re-writing.`
          : `${n} of this section's ${step.sources} sources ${n === 1 ? "is" : "are"} still unanswered. You can write the section now, but check what it rests on first.`),
        el("div", { class: "fx-waiting" }, waiting.slice(0, 8).map((s) =>
          el("button", { type: "button", class: "fx-waiting-src",
            title: `Go to ${s.name}, then come straight back here`,
            onclick: () => showSourceCard(s.id) }, s.name)))));
    } else {
      body.append(el("p", { class: "fx-lede" },
        `Every one of this section's ${step.sources} source${step.sources === 1 ? "" : "s"} has an answer. `
        + "Here is what the report now says — read it back, then sign it off."));
    }

    // ---- 1. what this section concludes -------------------------------------
    // The standardized statement, pre-suggested from the evidence. Set at reading
    // size and given a label: on the card-lined report pane it is one field among
    // eleven, and here it is the section's conclusion.
    if (section.dropdown) {
      const opts = DATA.dropdowns[section.dropdown] || [];
      const sel = el("select", { class: "fx-sec-choice", id: `fx-sec-choice-${section.id}`,
        "aria-label": `The standardized statement for ${section.title}`,
        onchange: (e) => {
          rstate.choice = e.target.value;
          save();
          refreshSection(section, body, rstate);
          if (section.bioDetail) syncBioDetail(section, body);
        } });
      opts.forEach((o) => sel.append(el("option", { value: o, selected: rstate.choice === o ? "selected" : null }, o)));
      const zone = el("div", { class: "fx-zone" },
        el("span", { class: "zone-label" }, "What this section concludes"), sel);
      // Biosecurity's declaration text is derived FROM the statement, so it is
      // painted by the same helper the report pane uses, into the same id — only
      // one mode's copy is ever in the document.
      if (section.bioDetail) zone.append(el("p", { class: "fx-sec-detail", id: "bio-detail" }));
      body.append(zone);
      if (section.bioDetail) syncBioDetail(section, body);
    }

    // ---- 2. anything inconsistent -------------------------------------------
    // Filled by refreshSection at the foot of this function, and re-filled live on
    // every keystroke in the note and every change of the statement above.
    body.append(el("div", { class: "r-warns fx-warns" }));

    // ---- 3. the detail -------------------------------------------------------
    const ta = el("textarea", { class: "note-field fx-sec-note", id: `fx-sec-note-${section.id}`, rows: "1",
      "aria-label": `The detail recorded under ${section.title}`,
      placeholder: "Free-text comments for this section…",
      oninput: (e) => { rstate.note = e.target.value; refreshSection(section, body, rstate); save(); autoGrow(e.target); } });
    ta.value = rstate.note || "";
    const detail = el("div", { class: "fx-zone" },
      el("span", { class: "zone-label" }, "The detail"), ta);
    // Drafts from THIS section's evidence plus the standard wording. Appends below
    // whatever is already written; it has never overwritten and must not start.
    const suggestion = sectionNarrative(section);
    if (suggestion) detail.append(el("div", { class: "fx-actions" },
      el("button", { type: "button", class: "btn-mini",
        title: "Draft this section from the collected evidence and standard wording (appends; never overwrites)",
        onclick: () => {
          const cur = (ta.value || "").trim();
          ta.value = cur ? cur + "\n\n" + suggestion : suggestion;
          rstate.note = ta.value;
          refreshSection(section, body, rstate); save(); autoGrow(ta);
        } }, "Insert suggested detail")));
    // The proforma's own hyperlink for the invasive / disease sections.
    const ref = section.ref && state.site && state.site.refs && state.site.refs[section.ref];
    if (ref) detail.append(el("p", { class: "fx-sec-ref" }, "Reference: ",
      el("a", { href: ref, target: "_blank", rel: "noopener" }, ref)));
    body.append(detail);

    // ---- 4. what it rests on -------------------------------------------------
    // The three-way split, unchanged: Findings at full weight, "Checked, nothing
    // found" on one line, "⚠ Not yet checked" as a caveat strip. Every source name
    // in it is a button to that source's step — and, because the jump starts here,
    // one that arms the way back (showSourceCard).
    const clamps = [];
    const evidence = renderSectionEvidence(includedCardsForSection(section.id), clamps);
    const rests = el("div", { class: "fx-zone fx-rests" },
      el("span", { class: "zone-label" }, "What it rests on"));
    rests.append(evidence || el("p", { class: "fx-lede" },
      "No source has been included into this section yet. A source is included as soon as it carries a note or a photo, "
      + "and its own step can point it here."));
    body.append(rests);
    measureClamps(clamps); // measured on the next frame, by which time this is in the document

    // ---- 5. reviewed ---------------------------------------------------------
    // The section's own tick — the same flag, setter and tally as the workbench's
    // checkbox, and the same thing this step's Continue records.
    body.append(el("div", { class: "fx-actions fx-review" },
      sectionReviewToggle(section.id, { box: body, inputId: `fx-sec-rev-${section.id}` }),
      el("button", { type: "button", class: "btn secondary", onclick: () => focusHandoffTo(step) },
        "Open this in the report pane ▸")));

    refreshSection(section, body, rstate); // the warnings, for the state as it stands
    queueCardMetrics();                    // …and the note's height, once it is laid out
    return body;
  }

  /* --------------------------------------------------------- the finish step
     Where the flow ends, and the only place in Focus mode that shows the whole
     report at once. By this point every section has been reviewed on a step of
     its own, so this is a last look and a handover — not a second review, and
     emphatically not a form.

     Six things, in the order a person leaving the building uses them:

       1  at a glance        what this site's sources came back with (#65)
       2  what's still missing   the report's own gaps, each one a jump
       3  unresolved warnings    the last moment they can be acted on (#64)
       4  read the whole thing   the assembled artefact, on screen
       5  Export ▾               the workbench's own menu, borrowed
       6  Check report           the workbench's own button, borrowed

     Items 5 and 6 are `adoptNode`s rather than copies, which is what makes "an
     export from Focus is byte-identical to an export from the workbench" true by
     construction: they are the same two controls, with the same handlers, and
     the artefact is built from state that has no per-mode half.

     Finishing is never gated on completeness. A person who has to hand something
     over now gets to — with every gap named. */
  function focusFinishBody(step, body) {
    body.append(el("p", { class: "fx-lede" }, FOCUS_LEDE["finish:export"]));
    const r = reportRollup();

    // ---- 1. at a glance ------------------------------------------------------
    // The traffic-light card, whole. Every row jumps to the first source that
    // came back that way, so "23 answered, 2 still not checked" is also the route
    // to the two.
    body.append(el("div", { class: "fx-zone" },
      el("span", { class: "zone-label" }, "At a glance"),
      renderFindingsGlance()));

    // ---- 2. what's still missing --------------------------------------------
    // The report pane's own roll-up, with its own wording (completenessGaps is
    // shared), but pointed at steps instead of at a scroll position:
    // showReportSection resolves to `sec:…` while Focus is live.
    const gaps = completenessGaps(r);
    const missing = el("div", { class: "fx-zone" },
      el("span", { class: "zone-label" }, "What's still missing"));
    if (!gaps.length) {
      missing.append(el("p", { class: "fx-finish-clear" },
        `✓ All ${r.total} sections carry a statement, a comment and included evidence — and every one is reviewed.`));
    } else {
      missing.append(el("p", { class: "fx-lede" }, `Of ${r.total} report sections:`));
      missing.append(el("ul", { class: "fx-gaps" }, gaps.map((g) => el("li", {},
        el("button", {
          type: "button", class: "fx-gap",
          title: `Go to the step that fixes the first of these: ${g.list[0].title}`,
          onclick: () => showReportSection(g.list[0].id),
        }, g.text(g.list.length))))));
    }
    body.append(missing);

    // ---- 3. unresolved warnings ---------------------------------------------
    // Only when there are some. An export is the last moment anybody can act on
    // them — which is why the export handler says so too (guardExport), and why
    // this row is a jump rather than a notice. (Whether they should also be
    // stripped OUT of the artefact is #64's question, not this step's.)
    if (r.warnCount) {
      const first = r.warnings[0].section;
      body.append(el("div", { class: "fx-zone" },
        el("span", { class: "zone-label" }, "Unresolved warnings"),
        el("button", {
          type: "button", class: "fx-finish-warn",
          title: `Go to the first: ${first.title}`,
          onclick: () => showReportSection(first.id),
        },
          el("span", { "aria-hidden": "true" }, "⚠ "),
          `${r.warnCount} consistency warning${r.warnCount === 1 ? "" : "s"} — first on ${first.title}`),
        el("p", { class: "fx-lede" },
          "These are the report contradicting itself — a statement that does not match the evidence under it. "
          + "Once the report leaves the app nobody can act on them, so this is the moment to.")));
    }

    // ---- 4, 5 and 6 — everything that takes the report out of the app --------
    const tools = el("div", { class: "fx-actions fx-finish-out" });
    // Export first, because it is what this step is for. The menu is the report
    // header's own node — same four formats, same order, same handlers.
    adoptNode($("#report-export-menu"), tools);
    tools.append(el("button", {
      type: "button", class: "btn secondary",
      title: "The whole assembled report, exactly as it will be handed over — on screen, without exporting a file first",
      onclick: () => openReportPreview(),
    }, "Read the whole report"));
    adoptNode($("#btn-check-report"), tools);
    body.append(tools);
    return body;
  }

  function focusHandoffBtn(step, label) {
    return el("div", { class: "fx-actions" },
      el("button", { type: "button", class: "btn secondary", onclick: () => focusHandoffTo(step) }, label + " ▸"));
  }

  // Switch modes and land on the thing the step was about. Ordering matters: the
  // workbench DOM does not exist until setUiMode has rebuilt it.
  function focusHandoffTo(step) {
    setUiMode("workbench");
    if (step.id.startsWith("src:")) { showSourceCard(step.ref); return; }
    if (step.id.startsWith("sec:")) { showReportSection(step.ref); return; }
    if (step.id.startsWith("checks:")) {
      revealLeftPane();
      // The step ids and the flow keys are not the same words ("checks:paste" is
      // the "applied" pass), so the mapping is the one FLOW_OF_STEP already owns.
      openFlowStep(FLOW_OF_STEP[step.id]);
      jumpTo($("#run-checks"));
      return;
    }
    if (step.id === "site:details") { revealLeftPane(); setSiteDetailsOpen(true); jumpTo($("#site-summary")); return; }
    // Both of these live inside step 2's panel, so the panel has to be open before
    // the jump — landing on a shut disclosure is landing nowhere.
    if (step.id === "site:maps") { revealLeftPane(); setSiteDetailsOpen(true); jumpTo($("#site-maps") || $("#site-summary")); return; }
    if (step.id === "site:photos") { revealLeftPane(); setSiteDetailsOpen(true, "#site-dropzone"); return; }
    if (step.id === "out:identity") { revealRightPane(); showReportSection(IDENTITY_SECTION); return; }
    if (step.id === "finish:export") { revealRightPane(); jumpTo($("#report-complete") || $("#report")); return; }
    jumpTo($("#workspace") || $("#site-picker"));
  }

  // ---------------------------------------------------------------- persistence
  // Per-site state is split across TWO localStorage keys:
  //   • the main key   — site + findings *text*, report, prefs (small; kilobytes)
  //   • <key>:img       — the photos + satellite map data URLs (large; can be MB)
  // save() fires on every keystroke (notes, captions). Photos can push the state
  // to several MB, and JSON.stringify-ing all of that base64 on every save was the
  // cause of the typing lag: as a site accumulates images, each note edit re-wrote
  // megabytes and froze the tab. Now the hot path (text) is always cheap, and the
  // heavy image blob is only re-serialised when images actually change — tracked by
  // `imagesDirty`. In-memory state (what renders/exports) is unaffected.
  const IMG_SUFFIX = ":img";
  let saveTimer = null;
  let imagesDirty = false;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }
  // Use after any change that adds/removes/edits a photo, reference image or the
  // satellite map, so the (separately-stored) image blob is rewritten on next save.
  function saveImages() {
    imagesDirty = true;
    save();
  }
  // Persist immediately, bypassing the debounce — used right before anything that
  // reassigns state.site (switching site, importing) or unloads the page, so a
  // pending edit for the *current* site is written before state moves on.
  function flushSave() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    saveNow();
  }
  function saveNow() {
    if (!state.site) return;
    const key = LS_PREFIX + siteKey(state.site);
    // Text payload — strip images out of each finding so this stays small and cheap
    // to serialise on every keystroke. state.findings itself is never mutated here.
    const findingsText = {};
    for (const [id, f] of Object.entries(state.findings)) {
      const { images, ...rest } = f; // `images` intentionally dropped from the text payload
      findingsText[id] = rest;
    }
    // Per-slot map size/labels (small — the heavy image data lives in the img key).
    const mapsMeta = {};
    for (const [k, ms] of Object.entries(state.maps || {})) mapsMeta[k] = { km: ms.km, labels: ms.labels };
    const textPayload = {
      v: 2, site: state.site, findings: findingsText, report: state.report,
      maps: mapsMeta,
      // Small (layer ids + one capture record, no picture) so it rides in the
      // text payload; the map image itself lives in the card's images, and so
      // do the legend swatches — see qldMapTextState.
      qldMap: qldMapTextState(),
      date: state.date,
      maintenance: state.maintenance,
      // Presentation state that belongs to this site rather than the browser: which
      // categories the operator has explicitly folded away or kept open, and which
      // slice of the list they were working — so reopening a site keeps their place.
      // …and Focus mode's cursor: the step's stable ID, never its index, because the
      // step list is derived and re-orders as work lands (an index would silently
      // point at a different step after any change). Nothing else about Focus mode
      // is stored — the steps themselves are recomputed from this payload.
      ui: { groups: state.groupOpen, filter: state.filter, flow: state.flow, focus: { step: focusCursor } },
    };
    try {
      localStorage.setItem(key, JSON.stringify(textPayload));
    } catch (err) {
      if (err && err.name !== "QuotaExceededError") { toast("Could not save locally"); return; }
      toast("Local storage is full — export your report soon.");
      return; // if even the small text payload won't fit, the image blob certainly won't
    }
    // Image payload — potentially megabytes; only rewritten when images changed.
    if (imagesDirty) {
      const findingImages = {};
      for (const [id, f] of Object.entries(state.findings))
        if (f.images && f.images.length) findingImages[id] = f.images;
      // Per-slot generated map images (data URLs). For a loaded batch these are the
      // avoidable bulk in storage — each visited site would otherwise persist two
      // large map JPEGs, and a big batch can blow the localStorage quota. So while a
      // batch is active we keep the maps in memory (they still render and travel into
      // every export) but don't persist them; they regenerate cheaply when the site
      // is reopened (mapsMeta above still remembers each slot's km/labels).
      const persistMaps = !(state.batch && state.batch.keys && state.batch.keys.length);
      const mapImages = {};
      if (persistMaps) for (const [k, ms] of Object.entries(state.maps || {})) if (ms.image) mapImages[k] = ms.image;
      const qldMapLegend = qldMapLegendState();
      const hasAny = state.siteImages.length || Object.keys(mapImages).length || Object.keys(findingImages).length || qldMapLegend;
      try {
        if (hasAny)
          localStorage.setItem(key + IMG_SUFFIX, JSON.stringify({ siteImages: state.siteImages, mapImages, findingImages, qldMapLegend }));
        else
          localStorage.removeItem(key + IMG_SUFFIX);
        imagesDirty = false;
      } catch (err) {
        if (err && err.name !== "QuotaExceededError") { imagesDirty = false; return; }
        // Photos + the satellite map are the likeliest reason for exceeding quota.
        // Drop them from local storage (they still live in memory + every export)
        // rather than retrying the same failing multi-MB write on every future save.
        imagesDirty = false;
        try { localStorage.removeItem(key + IMG_SUFFIX); } catch (_) {}
        toast("Local storage is full — photos aren't saved locally (notes still are). Export your report soon.");
      }
    }
  }
  /* ---- Queensland Globe map: what is persisted where ---------------------
     The capture record is small (layer ids and names) and rides in the text
     payload, which is rewritten on every keystroke. Its LEGEND SWATCHES are
     not small — they are base64 PNGs published by the services — so they are
     split out and stored with the images, which are only rewritten when an
     image actually changes. restore() puts them back together. */
  function qldMapTextState() {
    const qm = state.qldMap || { selection: null, capture: null };
    if (!qm.capture || !Array.isArray(qm.capture.layers)) return qm;
    return {
      selection: qm.selection || null,
      capture: Object.assign({}, qm.capture, {
        layers: qm.capture.layers.map(({ legend, ...rest }) => rest),
      }),
    };
  }
  function qldMapLegendState() {
    const cap = state.qldMap && state.qldMap.capture;
    if (!cap || !Array.isArray(cap.layers)) return null;
    const out = {};
    cap.layers.forEach((l) => { if (l && l.id && Array.isArray(l.legend) && l.legend.length) out[l.id] = l.legend; });
    return Object.keys(out).length ? out : null;
  }
  function applyQldMapLegend(byId) {
    const cap = state.qldMap && state.qldMap.capture;
    if (!cap || !Array.isArray(cap.layers) || !byId || typeof byId !== "object") return;
    cap.layers.forEach((l) => { if (l && byId[l.id]) l.legend = byId[l.id]; });
  }

  function restore() {
    try {
      const key = LS_PREFIX + siteKey(state.site);
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const d = JSON.parse(raw);
      state.findings = d.findings || {};
      state.report = d.report || {};
      state.maps = freshMaps();
      // Per-slot size/labels. New saves store `maps`; older single-map saves store
      // mapKm/mapLabels (→ seed the local slot).
      if (d.maps && typeof d.maps === "object") {
        for (const [k, mm] of Object.entries(d.maps)) {
          const ms = mapState(k);
          if (mm && typeof mm.km === "number") ms.km = mm.km;
          if (mm) ms.labels = mm.labels !== false;
        }
      } else if (d.mapKm) {
        const ms = mapState("local");
        ms.km = d.mapKm; ms.labels = d.mapLabels !== false;
      }
      state.qldMap = (d.qldMap && typeof d.qldMap === "object")
        ? { selection: Array.isArray(d.qldMap.selection) ? d.qldMap.selection : null, capture: d.qldMap.capture || null }
        : { selection: null, capture: null };
      state.date = d.date || state.date;
      state.maintenance = d.maintenance || "";
      state.groupOpen = (d.ui && d.ui.groups && typeof d.ui.groups === "object") ? { ...d.ui.groups } : {};
      state.filter = (d.ui && FILTERS[d.ui.filter]) ? d.ui.filter : "all";
      state.flow = normalizeFlow(d.ui && d.ui.flow);
      // Close the tab on step 19 and come back tomorrow to step 19. resolveFocusCursor
      // handles an id that no longer exists (a re-routed card, hidden internal sources).
      const fx = d.ui && d.ui.focus;
      focusCursor = (fx && typeof fx.step === "string") ? fx.step : null;
      // Images live in a separate key (v2). Fall back to the legacy embedded layout
      // (v1) for sites saved before the split, then mark dirty so the next save
      // migrates them out of the text key.
      const applyMapImages = (mapImages, legacySingle) => {
        if (mapImages && typeof mapImages === "object") {
          for (const [k, im] of Object.entries(mapImages)) {
            const ms = mapState(k);
            ms.image = (im && DATA_IMG_RE.test(im.dataUrl || "")) ? im : null;
          }
        } else if (legacySingle && DATA_IMG_RE.test(legacySingle.dataUrl || "")) {
          mapState("local").image = legacySingle; // migrate old single map into the local slot
        }
      };
      let imgRaw = null;
      try { imgRaw = localStorage.getItem(key + IMG_SUFFIX); } catch (_) {}
      if (imgRaw) {
        const di = JSON.parse(imgRaw) || {};
        state.siteImages = di.siteImages || [];
        applyMapImages(di.mapImages, di.mapImage);
        applyQldMapLegend(di.qldMapLegend);
        const fi = di.findingImages || {};
        for (const [id, imgs] of Object.entries(fi)) {
          if (!state.findings[id]) state.findings[id] = { status: STATUS.UNSET, note: "", result: null };
          state.findings[id].images = Array.isArray(imgs) ? imgs : [];
        }
        imagesDirty = !!di.mapImage; // a migrated legacy single map needs rewriting under the new layout
      } else {
        state.siteImages = d.siteImages || [];
        applyMapImages(d.mapImages, d.mapImage);
        imagesDirty = !!(state.siteImages.length || Object.values(state.maps).some((ms) => ms.image) ||
          Object.values(state.findings).some((f) => f.images && f.images.length));
      }
      // Every finding must have an images array (some were restored without one).
      for (const f of Object.values(state.findings)) if (!f.images) f.images = [];
      for (const ms of Object.values(state.maps)) ms.status = ms.image ? "ready" : "idle";
    } catch (_) { /* ignore corrupt entry */ }
  }

  // ---------------------------------------------------------------- export
  function buildFindings() {
    const list = sourcesForSite();
    return list.map((s) => {
      const f = state.findings[s.id] || { status: "unset", note: "" };
      return {
        id: s.id, name: s.name, category: s.category, jurisdiction: s.jurisdiction,
        internal: !!s.internal,
        url: buildUrl(s), status: f.status || "unset", note: f.note || "", reviewed: !!f.reviewed,
        result_text: f.result ? f.result.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "",
        images: (f.images || []).map(exportImage),
      };
    });
  }

  // Shared image serialization for exports/JSON — keeps the attribution (credit +
  // source page) with the photo so it round-trips through import and shows in HTML/PDF.
  function exportImage(im) {
    const o = { caption: im.caption || "", data_url: im.dataUrl };
    if (im.credit) o.credit = im.credit;
    if (im.source_url) o.source_url = im.source_url;
    if (isQldMapImage(im)) o.kind = QLD_MAP_KIND;
    return o;
  }

  // Serialize one map slot's generated image for export (or null if not ready).
  function mapExportObj(slot) {
    const ms = state.maps && state.maps[slot];
    if (!ms || !ms.image || !ms.image.dataUrl) return null;
    const m = ms.image;
    return { slot, title: (MAP_SLOT_BY_KEY[slot] || {}).title || slot, km: m.km, zoom: m.zoom, labels: !!m.labels,
      source: MAP_ATTRIB + (m.labels ? " · " + MAP_REF_ATTRIB : ""), data_url: m.dataUrl };
  }
  // All map slots as { slot: exportObj } (ready slots only).
  function exportMaps() {
    const out = {};
    for (const slot of MAP_SLOTS) { const o = mapExportObj(slot.key); if (o) out[slot.key] = o; }
    return out;
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
        lat: s.lat, lon: s.lon, assessment_date: state.date, site_maintenance: state.maintenance,
        // The report's front page carries its own review tick, like every section
        // below it. It travels in the site block rather than in `sections`, because
        // that array is the eleven proforma sections and a consumer counting them
        // should keep counting eleven.
        front_page_reviewed: !!(state.report[IDENTITY_SECTION] || {}).reviewed,
        images: (state.siteImages || []).map(exportImage),
        // Both locator maps, keyed by slot, so a re-import restores them. `map`
        // stays populated (local slot) for backward-compatible consumers.
        maps: exportMaps(),
        map: mapExportObj("local"),
      },
      sections: REPORT_SECTIONS.map((sec) => {
        const rstate = state.report[sec.id] || {};
        return {
          id: sec.id, title: sec.title,
          choice: rstate.choice || "",
          note: rstate.note || "",
          reviewed: !!rstate.reviewed,
          detail: sec.bioDetail ? (DATA.dropdowns.biosecurity_detail || {})[rstate.choice] || "" : "",
          warnings: sectionWarnings(sec, rstate),
          // Notes from the sources the operator included into this section (Include control).
          evidence_notes: includedCardsForSection(sec.id)
            .filter(({ f }) => f.note && f.note.trim())
            .map(({ src, f }) => ({ source: src.name, status: f.status || "unset", note: f.note.trim() })),
          images: photosForSection(sec).map(({ im, src }) => exportImage({ ...im, caption: im.caption || src.name })),
        };
      }),
      collection_log: buildFindings(),
      // Queensland Globe map provenance. Top-level (not nested under `site`) so
      // a consumer can find the layer list without walking the site block, and
      // so a re-import can rebuild the appendix even without the picture.
      qld_globe_map: qldMapExport(),
    };
  }

  // The map's layer list as exported/imported. null when no map was captured.
  function qldMapExport() {
    const cap = state.qldMap && state.qldMap.capture;
    if (!cap || !Array.isArray(cap.layers) || !cap.layers.length) return null;
    return {
      captured_at: cap.at ? new Date(cap.at).toISOString() : null,
      caption: cap.caption || "",
      lat: cap.lat != null ? cap.lat : state.site.lat,
      lon: cap.lon != null ? cap.lon : state.site.lon,
      scale: cap.scale || null,
      pin_in_view: cap.pin_in_view !== false,
      source: "Queensland Government spatial services (Queensland Globe layers)",
      selection: (state.qldMap.selection || cap.layers.map((l) => l.id)).filter(Boolean),
      // `legend` carries the service's own swatches, so a report exported to
      // JSON and re-imported still has a legend the map can be read against.
      layers: cap.layers.map((l) => {
        const row = { id: l.id, name: l.name, group: l.group, service: l.service, url: l.url, sublayer: l.sublayer };
        const legend = safeLegend(l.legend);
        if (legend.length) row.legend = legend;
        if (l.legend_more) row.legend_more = Math.max(0, +l.legend_more || 0);
        return row;
      }),
    };
  }

  function buildReportHtml(forPrint) {
    const r = reportObject();
    const s = r.site;
    // Click-to-enlarge is for the on-screen HTML export only; on paper the
    // overlay would be a second copy of the same picture. Reset per build so
    // repeated exports don't drift the fragment ids.
    const interactive = !forPrint;
    prMapSeq = 0;
    // esc() the data URL (not just captions) — this string is injected via innerHTML
    // (print) / a raw <script>-free template (HTML export), so an unescaped value
    // could otherwise break out of src="" if a crafted findings file supplied it.
    // Both locator maps, side by side, square + equally sized, filling the width
    // (see .pr-maps CSS in the export/print styles). Falls back to the legacy single
    // `map` if an imported file only carried one.
    const mapSlots = (s.maps && Object.keys(s.maps).length)
      ? MAP_SLOTS.map((slot) => s.maps[slot.key]).filter(Boolean)
      : (s.map && s.map.data_url ? [s.map] : []);
    const mapBlock = mapSlots.length
      ? `<div class="pr-sec pr-map"><h2>Location map${mapSlots.length > 1 ? "s" : ""}</h2>
          <div class="pr-maps">${mapSlots.map((m) => `<figure class="pr-map-fig">
            <img class="pr-map-img" src="${esc(m.data_url)}" alt="${esc(m.title || "Satellite locator map")}">
            <figcaption class="pr-map-cap">${esc(m.title || "Satellite locator")} — ${esc(String(m.km))} km across · centred on ${esc(s.lat)}, ${esc(s.lon)} · ${esc(m.source || MAP_ATTRIB)}</figcaption>
          </figure>`).join("")}</div></div>`
      : "";
    const siteShots = s.images && s.images.length
      ? `<div class="pr-sec"><h2>Site photographs</h2>${photosHtml(s.images, true, interactive)}</div>` : "";
    // The traffic-light card, from the same rollup the pane renders (#65). Sits
    // directly below the maps: the first thing after the reader has established
    // where the site is, and above the sections it points at.
    const summaryBlock = summaryHtml(interactive);
    const nl2br = (x) => esc(x).replace(/\n/g, "<br>");
    // The same three-way split the on-screen pane makes (see
    // renderSectionEvidence): the person receiving the report has to be able to
    // tell a finding from a source nobody has opened, and in a flat list they
    // could not. Built from `evidence_notes` as exported, so the JSON schema is
    // untouched — the status each entry already carries is what does the sorting.
    const evNames = (notes) => notes.map((e) =>
      esc(e.source) + (e.status === STATUS.FAILED ? " (search failed)" : "")).join(" · ");
    const evNotesHtml = (sec) => {
      const notes = sec.evidence_notes || [];
      if (!notes.length) return "";
      const found = notes.filter((e) => e.status === STATUS.FOUND);
      const none = notes.filter((e) => e.status === STATUS.NONE);
      const open = notes.filter((e) => e.status !== STATUS.FOUND && e.status !== STATUS.NONE);
      const rows = [];
      if (found.length)
        rows.push(`<p class="pr-ev-h">Findings (${found.length})</p>` + found.map((e) =>
          `<p class="pr-ev-item"><span class="st st-${esc(e.status)}">${esc(STATUS_LABEL[e.status] || e.status)}</span> <b>${esc(e.source)}</b> — ${esc(e.note)}</p>`).join(""));
      if (none.length)
        rows.push(`<p class="pr-ev-line pr-ev-none"><b>Checked, nothing found (${none.length}):</b> ${evNames(none)}</p>`);
      if (open.length)
        rows.push(`<p class="pr-ev-line pr-ev-caveat"><b>⚠ Not yet checked (${open.length}):</b> ${evNames(open)}`
          + ` — these sources have not been checked, so the statement above is not yet fully evidenced.</p>`);
      return `<div class="pr-ev">${rows.join("")}</div>`;
    };
    // `sec.warnings` is deliberately NOT rendered into the artefact. The
    // consistency checker talks to the *operator* about their own draft — second
    // person, "reconsider the statement", "add the specifics" — and this file is
    // the deliverable, read by someone who cannot act on that instruction. The
    // warnings keep working everywhere they face the operator (the on-screen
    // .r-warns strip, the header count, the Focus section step, the Check report
    // prompt, and `sections[].warnings` in the JSON interop object), and
    // guardExport() stops unresolved ones leaving unnoticed.
    // The "⚠ Not yet checked" caveat in evNotesHtml is the opposite case — a fact
    // about the assessment, addressed to the reader — and stays.
    // The section id is an anchor for the summary card's rows — but only in the
    // standalone HTML export. The print build's string is injected into the LIVE
    // document (#print-root, and the on-screen preview), where a second set of ids
    // would be a duplicate-id bug, and on paper a link is a promise it cannot keep.
    const secRows = r.sections.map((sec) => `<div class="pr-sec"${interactive ? ` id="pr-sec-${esc(sec.id)}"` : ""}><h2>${esc(sec.title)}</h2>
      ${sec.choice ? `<p><b>${esc(sec.choice)}</b></p>` : ""}
      ${sec.detail ? `<p>${nl2br(sec.detail)}</p>` : ""}
      ${sec.note ? `<p>${nl2br(sec.note)}</p>` : ""}
      ${evNotesHtml(sec)}
      ${photosHtml(sec.images, false, interactive)}</div>`).join("");
    // Internal / login-only sources are operator working items — keep their
    // "check internal system X" instructions out of the exported report entirely.
    const logRows = r.collection_log.filter((c) => !c.internal).map((c) => `<tr>
      <td>${esc(c.name)}</td>
      <td class="st st-${c.status}">${esc(STATUS_LABEL[c.status] || c.status)}</td>
      <td>${esc(c.result_text || c.note || "")}</td>
      <td><a href="${esc(c.url)}">link</a></td></tr>`).join("");
    const appendixBlock = appendixHtml();
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
      ${mapBlock}
      ${summaryBlock}
      ${siteShots}
      ${secRows}
      <div class="pr-sec"><h2>Collection log — sources checked</h2>
        <table><thead><tr><th>Source</th><th>Result</th><th>Evidence / notes</th><th></th></tr></thead>
        <tbody>${logRows}</tbody></table></div>
      ${appendixBlock}
      <p style="margin-top:10px;color:#555">Prepared with ESS Workbench · contact enviro@bom.gov.au</p>
    </div>`;
  }

  /* The summary card as report HTML — the same rows, the same glyphs and the same
     words as the on-screen card, from the same summaryRollup(). No evidence text,
     no species, no source names: on paper as on screen, its only job is to point at
     the sections worth reading.

     In the standalone HTML export each row links to its section anchor. In
     Print/PDF the rows are inert text. */
  function summaryHtml(interactive) {
    const rows = summaryRollup();
    if (!rows.length) return "";
    const body = rows.map((r) => {
      const s = SUM_STATES[r.state];
      const name = interactive ? `<a href="#pr-sec-${esc(r.section)}">${esc(r.title)}</a>` : esc(r.title);
      return `<tr class="pr-sum-row pr-sum-${esc(r.state)}">
        <td class="pr-sum-mark">${s.glyph}</td>
        <td class="pr-sum-state">${esc(s.label)}</td>
        <td class="pr-sum-name">${name}</td></tr>`;
    }).join("");
    return `<div class="pr-sec pr-summary"><h2>Findings at a glance</h2>
      <p class="pr-sum-verdict">${esc(summaryVerdict(rows))}</p>
      <table class="pr-sum"><tbody>${body}</tbody></table>
      <p class="pr-sum-foot">This table points at the sections worth reading; the detail — and what was
        and was not checked — is in the sections themselves.</p></div>`;
  }

  // The map-layer appendix as report HTML — a two-column list so forty layers
  // take one page rather than four, and page-broken away from the findings.
  function appendixHtml() {
    const a = qldMapAppendixRows();
    if (!a) return "";
    return `<div class="pr-sec pr-appendix"><h2>${esc(a.title)}</h2>
      <p class="pr-appendix-blurb">${esc(a.blurb)}</p>
      <div class="pr-appendix-cols">${a.groups.map((g) => `<div class="pr-appendix-group">
        <h3>${esc(g.title)}</h3>
        ${g.source ? `<p class="pr-appendix-src pr-appendix-gsrc">${esc(g.source)}</p>` : ""}
        <ul>${g.layers.map(appendixItemHtml).join("")}</ul>
      </div>`).join("")}</div></div>`;
  }

  function doPrint() {
    $("#print-root").innerHTML = buildReportHtml(true);
    window.print();
  }

  /* --------------------------------------- the whole report, before it leaves
     Focus mode shows one section at a time, on purpose — but the operator about
     to hand a report over is entitled to read the thing they are handing over,
     and "export it and open the file" is a poor answer to that. So the finish
     step carries one action that puts the assembled artefact on screen.

     It is the SAME string the printed report is built from (`buildReportHtml`),
     wearing the same stylesheet (`.pr-paper`, shared with `#print-root`), so
     this is a preview of the deliverable rather than a third rendering of the
     report. Read-only by construction: there is nothing to edit in a built
     string, and every route to changing something is a step away. */
  let RP = null, rpRelease = null;
  function ensureReportPreview() {
    if (RP) return RP;
    const paper = el("div", { class: "rp-paper pr-paper" });
    const close = el("button", { type: "button", class: "btn tertiary", onclick: () => closeReportPreview() }, "✕ Close");
    const frame = el("div", { class: "rp-frame" },
      el("div", { class: "rp-head" },
        el("div", {},
          el("h2", { class: "rp-title", id: "rp-title" }, "The whole report, as it will leave the app"),
          el("p", { class: "rp-sub" }, "Read-only. Anything that needs changing is on the step it belongs to.")),
        close),
      paper);
    const overlay = el("div", { class: "rp-overlay", id: "report-preview", role: "dialog",
      "aria-modal": "true", "aria-labelledby": "rp-title" }, frame);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeReportPreview(); });
    document.body.append(overlay);
    RP = { overlay, paper, close };
    return RP;
  }
  const rpKeydown = (e) => { if (e.key === "Escape") { e.preventDefault(); closeReportPreview(); } };
  function openReportPreview() {
    if (!state.site) return;
    const rp = ensureReportPreview();
    // Built fresh every time: the point of this surface is that it shows the
    // report as it stands right now, not as it stood the last time it was opened.
    rp.paper.innerHTML = buildReportHtml(true);
    rp.overlay.classList.add("show");
    document.addEventListener("keydown", rpKeydown);
    rpRelease = trapFocus(rp.overlay); // …and hands focus back to the button that opened it
    rp.close.focus();
  }
  function closeReportPreview() {
    if (!RP) return;
    RP.overlay.classList.remove("show");
    RP.paper.innerHTML = ""; // a report carries every photo inline; don't hold two copies
    document.removeEventListener("keydown", rpKeydown);
    if (rpRelease) { rpRelease(); rpRelease = null; }
  }
  // Every export runs through here, so this is where "the operator has finished a
  // site" is recorded once — after which the how-to guide is on demand only.
  function download(name, mime, text) {
    markOnboarded();
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
      .k{color:#555} .st{font-weight:700} .st-found{color:#c1123c}.st-none{color:#8a6d1a}.st-failed{color:#b3261e}.st-manual{color:#3a5a99}
      .pr-photos{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px} .pr-photos figure{margin:0;width:150px}
      .pr-photos img{width:100%;height:110px;object-fit:cover;border:1px solid #bbb;border-radius:4px}
      .pr-photos figcaption{font-size:10px;color:#444;margin-top:2px}
      .pr-photos figcaption .credit{display:block;font-size:9px;color:#777;margin-top:1px}
      .pr-photos figcaption .credit a{color:#777}
      .pr-photos.pr-photos-large{gap:12px} .pr-photos.pr-photos-large figure{width:300px}
      .pr-photos.pr-photos-large img{height:auto;max-height:340px;object-fit:contain}
      .pr-ev{margin:6px 0 0} .pr-ev-item{font-size:11.5px;color:#333;margin:3px 0}
      /* Findings, empty searches and outstanding sources are three different
         things — the exported report says so, exactly as the pane does. */
      .pr-ev-h{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#444;margin:6px 0 2px}
      .pr-ev-line{font-size:11px;color:#333;margin:5px 0 0}
      .pr-ev-none{color:#444}
      .pr-ev-caveat{color:#7a5f10;background:#f6efd8;border-left:3px solid #8a6d1a;border-radius:4px;padding:4px 8px}
      /* Findings at a glance — one row per section, marker + words + section name.
         The glyph and the words both carry the state, so the table still reads on a
         greyscale photocopier; the colour is the confirmation, never the message. */
      .pr-summary table{font-size:11.5px}
      .pr-sum-verdict{font-size:12px;font-weight:700;margin:0 0 6px}
      .pr-sum td{border:none;border-bottom:1px solid #e2e2e2;padding:3px 6px}
      .pr-sum tr:last-child td{border-bottom:none}
      /* The stack is for ◐ (U+25D0) — see .r-sum-mark in styles.css. This file gets
         opened on machines we know nothing about, so the marker carries its own. */
      .pr-sum-mark{width:14px;text-align:center;font-size:13px;line-height:1;
        font-family:"Segoe UI Symbol","Apple Symbols","Noto Sans Symbols 2","DejaVu Sans",sans-serif}
      .pr-sum-state{width:34%;font-weight:700;white-space:nowrap}
      .pr-sum-name a{color:inherit}
      .pr-sum-found .pr-sum-mark,.pr-sum-found .pr-sum-state{color:#c1123c}
      .pr-sum-partial .pr-sum-mark,.pr-sum-partial .pr-sum-state{color:#8a6d1a}
      .pr-sum-clear .pr-sum-mark,.pr-sum-clear .pr-sum-state{color:#555}
      .pr-sum-na td,.pr-sum-na .pr-sum-name a{color:#8a8a8a}
      .pr-sum-foot{font-size:10px;color:#666;margin:6px 0 0}
      .pr-maps{display:flex;gap:12px;align-items:flex-start}
      .pr-map-fig{margin:0;flex:1 1 0;min-width:0}
      /* 4/3 rather than square: the stitched image is square and centred on the pin,
         so a 4/3 window crops evenly top and bottom and gives the page back a
         quarter of the height the two maps used to take. */
      .pr-map-img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;border:1px solid #bbb;border-radius:6px}
      .pr-map-cap{font-size:10px;color:#444;margin:4px 0 0}
      .pr-appendix{page-break-before:always;break-before:page}
      .pr-appendix-blurb{font-size:11.5px;color:#444;margin:0 0 10px}
      .pr-appendix-cols{column-count:2;column-gap:22px}
      .pr-appendix-group{break-inside:avoid;page-break-inside:avoid;margin:0 0 10px}
      .pr-appendix-group h3{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#12507b;margin:0 0 4px}
      .pr-appendix-group ul{margin:0;padding-left:16px}
      .pr-appendix-group li{font-size:11px;line-height:1.45;margin:0 0 3px}
      .pr-appendix-src{display:block;font-size:9.5px;color:#777}
      .pr-appendix-gsrc{margin:0 0 4px;font-style:italic}
      .pr-appendix-cols li{margin:0 0 6px}
      /* Legend box per layer — the swatch is the service's own symbol, so a
         colour on the map can be traced back to the layer that drew it. */
      .pr-legend{display:block;margin:2px 0 0}
      .pr-legend-key{display:flex;align-items:center;gap:5px;font-size:10px;color:#444}
      .pr-legend-swatch{width:14px;height:14px;flex:0 0 auto;object-fit:contain;border:1px solid #bbb;
        border-radius:2px;background:#fff;vertical-align:-3px;margin-right:5px}
      .pr-legend-more{display:block;font-size:9.5px;color:#888;font-style:italic}
      /* The Queensland Globe map fills its section and its height follows the
         width — it is the one picture in the report that has to be read. */
      .pr-globe{margin:8px 0 0}
      .pr-globe-link{display:block;cursor:zoom-in}
      .pr-globe-img{display:block;width:100%;height:auto;border:1px solid #bbb;border-radius:6px;background:#fff}
      .pr-globe-cap{font-size:10.5px;color:#444;margin:4px 0 0}
      /* Click-to-enlarge with no JavaScript: the link targets the overlay and
         :target reveals it, so a saved copy of this file still works offline. */
      .pr-lightbox{display:none}
      .pr-lightbox:target{display:flex;position:fixed;inset:0;z-index:99;align-items:center;
        justify-content:center;padding:2vh 2vw;background:rgba(8,14,18,.92)}
      .pr-lightbox-bg{position:absolute;inset:0}
      .pr-lightbox-img{position:relative;max-width:100%;max-height:96vh;object-fit:contain;
        border-radius:6px;background:#fff}
      .pr-lightbox-x{position:absolute;top:12px;right:16px;z-index:1;color:#fff;font-size:13px;
        text-decoration:none;background:rgba(0,0,0,.55);border-radius:6px;padding:6px 12px}
      @media print{.pr-lightbox,.pr-lightbox:target{display:none !important}
        .pr-globe-link{cursor:default}}</style>
      </head><body>${buildReportHtml(false)}</body></html>`;
    download(`ESS_${slug(state.site.name)}_${state.date || "draft"}.html`, "text/html", html);
  }
  function downloadJson() {
    download(`ESS_${slug(state.site.name)}_${state.date || "draft"}.json`, "application/json", JSON.stringify(reportObject(), null, 2));
  }
  function copySummary() {
    const r = reportObject();
    const lines = [`ESS — ${r.site.name} (${r.site.state}, ${r.site.station_num || "no station #"})`,
      `Lat/Long: ${r.site.lat}, ${r.site.lon}  ·  Date: ${r.site.assessment_date}`, ""];
    r.sections.forEach((sec) => {
      if (sec.choice || sec.note || (sec.evidence_notes && sec.evidence_notes.length))
        lines.push(`• ${sec.title}: ${sec.choice || ""}${sec.note ? " — " + sec.note : ""}`);
      (sec.evidence_notes || []).forEach((e) => lines.push(`    – [${(STATUS_LABEL[e.status] || e.status)}] ${e.source}: ${e.note}`));
    });
    lines.push("", "Collection log:");
    r.collection_log.filter((c) => !c.internal).forEach((c) => lines.push(`  [${(STATUS_LABEL[c.status] || c.status).toUpperCase()}] ${c.name}${c.note ? " — " + c.note : ""}`));
    copy(lines.join("\n"));
  }

  /* ------------------------------------------- exporting over an open warning
     A consistency warning is the report contradicting itself — a section that
     says "nothing found" over evidence that found something. They are the
     report's own doubts about the working copy, and an export is the last moment
     anybody can act on them: whatever leaves the app is what the recipient reads.
     Saying so at that moment is worth one dialog.

     Worth ONE. It is not a gate: a person who has to hand something over now
     gets to, with the gaps named. So it warns once per site per session, and
     only when the operator went ahead — a warning that fires on all four export
     formats in turn is a warning that gets clicked through. */
  const exportWarned = new Set(); // siteKey of a site whose warnings were accepted
  function guardExport(run) {
    return (e) => {
      const r = state.site ? reportRollup() : null;
      const key = state.site ? siteKey(state.site) : "";
      if (r && r.warnCount && !exportWarned.has(key)) {
        const n = r.warnCount;
        const first = r.warnings[0].section;
        const ok = confirm(
          `${n} consistency warning${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} still open on this report`
          + ` — the first is on ${first.title}.\n\n`
          + "These are the report's own checks on itself. They do not appear in the exported"
          + " report — it is the handover document, and its reader cannot act on them.\n\n"
          + "OK to export anyway, or Cancel to go to the first one.");
        if (!ok) { showReportSection(first.id); return; }
        exportWarned.add(key);
      }
      run(e);
    };
  }
  // Build a complete, self-contained, model-agnostic prompt for the current
  // site. It embeds every step, every applicable source aimed at the location,
  // the standardized report wording, and a ready-to-fill ess-findings/1
  // skeleton — so a user can paste it into ANY LLM/assistant, do the research
  // externally, and paste the JSON straight back into the step 3 box it came from.
  // A short top note points Claude Code users at the packaged ess-collect skill
  // as a shortcut (it produces the same schema).
  function buildFullPrompt() {
    const s = state.site;
    const date = ($("#fld-date") && $("#fld-date").value) || state.date || new Date().toISOString().slice(0, 10);
    const list = sourcesForSite();
    const cats = (DATA.sourcesMeta && DATA.sourcesMeta.categories) || [];
    const idpart = s.station_num ? `Bureau station ${s.station_num}` : "manual coordinate entry (no station number)";
    const L = [];

    L.push(`# Environmental Site Summary (ESS) — desktop assessment`, ``);
    L.push(`> Running Claude Code inside this project's repository? You can skip the manual research and run the packaged \`ess-collect\` skill instead (e.g. ask: "Run an ESS for ${s.name}"); it fills the same JSON described below. Otherwise, ignore this note and follow the prompt in any AI assistant.`, ``);
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

    L.push(`## Threatened species — classify plants vs animals vs communities`);
    L.push(`Broad biodiversity registers (EPBC PMST, Atlas of Living Australia, Queensland WildNet, NSW BioNet, state atlases) return **both flora and fauna** in one result. Do NOT lump everything under one heading. For every threatened taxon you find, decide what it is and record it under the matching report section:`);
    L.push(`- a **plant** → **Threatened Flora** (\`threatened_flora\`)`);
    L.push(`- an **animal** (mammal, bird, reptile, amphibian, fish, invertebrate) → **Threatened Fauna** (\`threatened_fauna\`)`);
    L.push(`- an **ecological community / regional ecosystem / habitat** → **Threatened Habitat** (\`threatened_habitat\`)`);
    L.push(`Put each taxon's name in the note of the correct section (a threatened plant must never end up under Threatened Fauna). If unsure whether a name is a plant or an animal, look it up before filing it.`, ``);

    L.push(`## Internal / login-only sources — operator action list, kept out of the report`);
    L.push(`Some sources are internal Bureau of Meteorology systems (marked "internal / login-only" below — e.g. the permits register, POPE / leasing SharePoint). An external assistant cannot log in, so record these as \`manual\` with a short reminder of what a staff member must check. These are an **operator action list only** — the ESS Workbench keeps their notes OUT of the final exported report, so keep the note brief and staff-facing; do not treat them as report content.`, ``);

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
        // Surface any public API so an assistant with web-fetch can query it directly
        // (e.g. Queensland WildNet, Atlas of Living Australia) rather than treating
        // the source as manual. Fetch runs server-side, so it bypasses browser CORS.
        if (src.api && (src.api.openapi || src.api.base_url || src.api.endpoint || src.api.dataset)) {
          const parts = [];
          if (src.api.base_url) parts.push(`base ${src.api.base_url}`);
          if (src.api.endpoint) parts.push(`endpoint ${src.api.endpoint}`);
          if (src.api.openapi) parts.push(`OpenAPI ${src.api.openapi}`);
          if (src.api.dataset) parts.push(`dataset ${src.api.dataset}`);
          L.push(`- Public API: ${parts.join(" · ")}.${src.api.docs ? " " + src.api.docs : ""} Query it for the point (lat ${s.lat}, lon ${s.lon}) and radius, then classify each taxon (flora/fauna/community) into the correct section.`);
        }
        if (src.id === "epbc-pmst" && DATA.sourcesMeta.epbc_matters)
          L.push(`- Record which of these matter types are returned: ${DATA.sourcesMeta.epbc_matters.join("; ")}.`);
        if (src.web_search) L.push(`- Web-search idea: "${fillTemplate(src.web_search)}"`);
        if (src.no_result_means) L.push(`- If nothing found → \`none\`: ${src.no_result_means}`);
        if (src.internal) L.push(`- Note: internal Bureau of Meteorology system — an external assistant cannot log in, so this is normally \`manual\`. Keep the note brief and staff-facing: it is an operator action item and the tool keeps it OUT of the exported ESS report.`);
      });
    }
    L.push(``);

    L.push(`## Report wording — pick the exact standardized phrase`);
    L.push(`For each report section, choose one phrase verbatim from its list (this is the wording the ESS proforma requires). If you are unsure, leave it blank and the tool will suggest one from your source findings.`);
    L.push(`Note the option "Known to occur in the region but not present within or immediately adjacent to the site." — pick it (for the threatened flora/fauna/habitat and invasive plant/animal sections) when a matter is recorded across the wider region/locality but the records do not fall within, or immediately next to, the site itself. Use the "at this site" option only when the records actually coincide with the site.`);
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
      collection_log: list.map((src) => {
        const entry = { id: src.id, name: src.name, url: buildUrl(src), status: "", note: "", result_text: "" };
        // Species/subject sources carry an image_subjects hint so the tool can
        // auto-fetch a labelled reference photo per identified species on import.
        if (WIKI_IMAGE_CATEGORIES.has(src.category)) entry.image_subjects = [];
        return entry;
      }),
    };

    L.push(`## What to return`);
    L.push(`Fill in the JSON object below and return **only** that object — no commentary, no markdown fences — so it can be pasted straight into the tool at step 3, "Paste its reply back here".`);
    L.push(`Rules:`);
    L.push(`- Keep every \`id\` exactly as given; do not add, remove or rename entries in \`collection_log\` or \`sections\`.`);
    L.push(`- In \`collection_log\`, set \`status\` to one of: found, none, failed, manual. Put a one-line evidence summary in \`note\`, and any longer detail (counts, species names, distances, dates) in \`result_text\`.`);
    L.push(`- Where an entry has an \`image_subjects\` array (the species/subject sources) and you marked it \`found\`, list the identifiable species/subject names there (common or scientific, e.g. "Gamba grass", "Phytophthora cinnamomi"). The tool auto-fetches a labelled reference photo for each on import. Leave it empty otherwise.`);
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
    flashButton((e && e.currentTarget) || $("#btn-copy-prompt"));
    return copy(buildFullPrompt());
  }

  // Render a finished report as compact plain text for an external reviewer.
  // Mirrors what the exported report contains — internal / login-only sources are
  // operator actions and stay out, exactly as buildReportHtml drops them.
  function reportToPlainText(r) {
    const s = r.site;
    const L = [];
    L.push(`SITE: ${s.name}`);
    L.push(`Station #: ${s.station_num || "—"} · WMO: ${s.wmo || "—"} · State: ${s.state || "?"} · Delivery group: ${s.delivery_group || "—"}`);
    L.push(`Facility: ${(s.facility_types || []).join(", ") || "—"} · Site maintenance: ${s.site_maintenance || "—"}`);
    L.push(`Latitude: ${s.lat} · Longitude: ${s.lon} · Assessment date: ${s.assessment_date || "—"}`);
    L.push(``, `REPORT SECTIONS`);
    (r.sections || []).forEach((sec) => {
      L.push(``, `## ${sec.title}`);
      if (sec.choice) L.push(`Standardized statement: ${sec.choice}`);
      if (sec.detail && sec.detail.trim()) L.push(sec.detail.trim());
      if (sec.note && sec.note.trim()) L.push(sec.note.trim());
      (sec.evidence_notes || []).forEach((e) => L.push(`  - evidence [${STATUS_LABEL[e.status] || e.status}] ${e.source}: ${e.note}`));
      if (!sec.choice && !(sec.note && sec.note.trim()) && !(sec.evidence_notes && sec.evidence_notes.length)) L.push(`(no content recorded)`);
    });
    L.push(``, `COLLECTION LOG (sources checked)`);
    (r.collection_log || []).filter((c) => !c.internal).forEach((c) => {
      const detail = c.result_text || c.note;
      L.push(`  [${(STATUS_LABEL[c.status] || c.status).toUpperCase()}] ${c.name}${detail ? " — " + detail : ""}`);
    });
    return L.join("\n");
  }

  // Build a precise, self-contained fact- & consistency-check prompt for a
  // FINISHED report, to hand to any assistant. The output contract is
  // deliberately rigid — a fixed four-section structure with tables and word
  // caps — because some assistants (notably Microsoft 365 Copilot) otherwise
  // return verbose, inconsistently-structured reviews. Takes a reportObject()-
  // shaped object (default: the current site) so the batch flow can reuse it
  // per site.
  // The "what to check" checklist, shared by the single-site and batch reviewers.
  // Pass the site for site-specific geography wording; pass null for the generic
  // (per-site) phrasing used when several reports are reviewed at once.
  function reviewChecklistLines(s) {
    const geo = s
      ? `- Geography — the coordinates (lat ${s.lat}, lon ${s.lon}) actually fall within the stated State/Territory (${s.state || "unstated"}); and the local council / region / weeds authority named in the report is the one that truly governs that location. Pasting another region's weed or pest list is a common error.`
      : `- Geography — each site's stated coordinates actually fall within its stated State/Territory; and the local council / region / weeds authority named is the one that truly governs that location. Pasting another region's weed or pest list is a common error.`;
    return [
      `**Factual accuracy** (verify against authoritative / public sources where you can):`,
      geo,
      `- Species & communities — each named species or ecological community is a real taxon, and its stated conservation status (EPBC national and/or the relevant State Act) is correct and current.`,
      `- Heritage & protected areas — named heritage places, Ramsar wetlands, marine parks and Indigenous Protected Areas exist and are genuinely at or near the site.`,
      ``,
      `**Internal consistency** (read the report against itself — no web access needed):`,
      `- Statement vs evidence — a section whose standardized statement says "There are no known…" must NOT carry evidence or a narrative that lists matters found; and a "…are present / known to occur" statement MUST be backed by named specifics.`,
      `- Correct section — a threatened **plant** belongs under Threatened Flora, an **animal** under Threatened Fauna, an **ecological community / regional ecosystem** under Threatened Habitat. Flag anything filed in the wrong section.`,
      `- Migratory ≠ threatened — listed migratory species are a separate matter of national significance; flag any lumped in with threatened fauna.`,
      `- Buffer wording — a matter recorded only across the wider region/buffer should read "…in the local area" or "…in the region but not at the site", not "…at this site", unless there is an on-site record.`,
      `- Unsupported hazards — anything asserted (e.g. acid sulfate soils) with no supporting source, especially for an inland / upland site.`,
      ``,
      `**Gaps:** any source in the collection log left unchecked, or marked FAILED / MANUAL, that still needs a human; and any contradiction between the site header, the section narratives, and the collection log.`,
    ];
  }

  // The rigid output contract, shared by both reviewers. `perSiteHeading`, when
  // given, is prepended so a batch review repeats the block under each site.
  function reviewOutputContractLines(perSiteHeading) {
    return [
      `Reply with ONLY the four numbered sections below${perSiteHeading ? `, ${perSiteHeading}` : ""}, in this order, with these exact headings. No preamble, no restating the report, no closing summary, no praise, no emoji. Be terse — at most one sentence per table cell — and keep each report's reply under ~400 words excluding tables.`,
      ``,
      `### 1. Verdict`,
      `A single line: one of \`PASS\` / \`PASS WITH FIXES\` / \`NEEDS WORK\`, then " — " then a reason of 20 words or fewer.`,
      ``,
      `### 2. Issues`,
      `A Markdown table with exactly these columns and no others: \`# | Severity | Section | Issue | Recommended fix\`. Severity is High, Medium or Low. One row per issue, High first. If there are none, write exactly \`None.\` and omit the table.`,
      ``,
      `### 3. Fact checks`,
      `A Markdown table with exactly these columns and no others: \`Claim checked | Verdict | Source\`. Verdict is Confirmed, Refuted or Unverifiable. Include only claims material to the assessment (species, statuses, heritage places, geography, council/region) — maximum 12 rows. Cite the source name + URL you used. If you have no web access, mark every claim \`Unverifiable\`, source \`no web access\`, and say so in the Verdict line.`,
      ``,
      `### 4. Outstanding / gaps`,
      `A short bullet list of unchecked / failed / manual sources or unsupported claims still needing a human. If none, write exactly \`None.\``,
      ``,
      `Rules: do NOT reproduce the report back to me; do NOT supply a fully rewritten report (recommend targeted fixes only); if you cannot verify a claim mark it \`Unverifiable\` — never guess or invent a source.`,
    ];
  }

  function sectionFlags(r) {
    const flags = [];
    (r.sections || []).forEach((sec) => (sec.warnings || []).forEach((w) => flags.push(`${sec.title} — ${w}`)));
    return flags;
  }

  function buildReviewPrompt(report) {
    const r = report || reportObject();
    const flags = sectionFlags(r);
    const L = [];
    L.push(`# Environmental Site Summary (ESS) — independent fact & consistency check`, ``);
    L.push(`> In a Claude Code session in this project's repo you can instead just say "check this ESS report". Otherwise paste this whole message into any assistant (ChatGPT, Gemini, Claude, Microsoft 365 Copilot…).`, ``);
    L.push(`## Your task`);
    L.push(`You are a meticulous reviewer of an Australian **Environmental Site Summary (ESS)** — a desk-based assessment of the environmental, heritage and biosecurity matters near a site. A finished draft is provided under "The report". **Do not rewrite it.** Independently check it for (1) factual accuracy, (2) internal consistency, and (3) gaps, using web search where you are able. Then reply in the exact structure under "Output format" — and nothing else.`, ``);
    L.push(`## What to check`, ...reviewChecklistLines(r.site), ``);
    if (flags.length) {
      L.push(`### Automated flags the tool already raised (verify and extend — do not just repeat these)`);
      flags.forEach((f) => L.push(`- ${f}`));
      L.push(``);
    }
    L.push(`## The report`, ``, "```", reportToPlainText(r), "```", ``);
    L.push(`## Output format — follow this EXACTLY`, ...reviewOutputContractLines());
    return L.join("\n");
  }

  // Combined fact/consistency-check prompt covering every site in the loaded batch.
  // Reuses the same checklist + rigid output contract, stated once, then embeds each
  // site's report; the model repeats the 4-section block per site and adds a final
  // one-line-per-site summary table. Visits each site's stored state (no render) and
  // restores the previously-active site afterwards.
  function buildBatchReviewPrompt() {
    if (!state.batch || !state.batch.keys.length) return "";
    flushSave();
    const prevKey = state.site ? siteKey(state.site) : null;
    const reports = [];
    state.batch.keys.forEach((key) => {
      const site = siteFromKey(key);
      if (!site) return;
      loadSiteState(site);
      reports.push(reportObject());
    });
    const back = prevKey ? siteFromKey(prevKey) : null;
    if (back) loadSiteState(back); // restore state to the site that was open
    if (!reports.length) return "";

    const L = [];
    L.push(`# Environmental Site Summaries (ESS) — independent fact & consistency check (batch of ${reports.length})`, ``);
    L.push(`> In a Claude Code session in this project's repo you can instead say "check this ESS batch". Otherwise paste this whole message into any assistant (ChatGPT, Gemini, Claude, Microsoft 365 Copilot…).`, ``);
    L.push(`## Your task`);
    L.push(`You are a meticulous reviewer of Australian **Environmental Site Summaries (ESS)** — desk-based assessments of the environmental, heritage and biosecurity matters near a site. ${reports.length} finished drafts are provided under "The reports". **Do not rewrite them.** Independently check EACH for (1) factual accuracy, (2) internal consistency, and (3) gaps, using web search where you are able. Reply in the exact structure under "Output format" — and nothing else.`, ``);
    L.push(`## What to check (apply to every report)`, ...reviewChecklistLines(null), ``);
    L.push(`## The reports`, ``);
    reports.forEach((r, i) => {
      const flags = sectionFlags(r);
      L.push(`### Report ${i + 1} — ${r.site.name}`);
      if (flags.length) {
        L.push(`Automated flags the tool already raised (verify and extend): ${flags.join(" · ")}`);
      }
      L.push("```", reportToPlainText(r), "```", ``);
    });
    L.push(`## Output format — follow this EXACTLY`);
    L.push(`For EACH report above, output the four-section block below under a level-2 heading \`## <site name>\` (in the same order the reports are given). ${reviewOutputContractLines("repeated once per report").join("\n")}`, ``);
    L.push(`## Finally — batch summary`);
    L.push(`After all per-report blocks, add one more heading \`## Batch summary\` with a Markdown table, columns exactly: \`Site | Verdict | High | Med | Low\` — one row per report, counts of issues at each severity. Nothing after the table.`);
    return L.join("\n");
  }

  function copyReviewPrompt(e) {
    if (!state.site) { toast("Load a site first"); return; }
    copy(buildReviewPrompt(), "Review prompt copied — paste it into your assistant");
    flashButton((e && e.currentTarget) || $("#btn-check-report"));
  }

  function copyBatchReviewPrompt(e) {
    if (!state.batch || !state.batch.keys.length) { toast("Import a batch first"); return; }
    const p = buildBatchReviewPrompt();
    if (!p) { toast("No batch reports to check"); return; }
    copy(p, "Batch review prompt copied — paste it into your assistant");
    flashButton((e && e.currentTarget) || $("#btn-batch-review"));
  }

  // ---------------------------------------------------------------- batch bar
  function readSitePayload(key) {
    try { return JSON.parse(localStorage.getItem(LS_PREFIX + key) || "null"); } catch (_) { return null; }
  }
  function siteFromKey(key) { const d = readSitePayload(key); return d && d.site ? d.site : null; }

  // Reads a stored payload rather than live state, so it can't go through
  // isOutstanding — but it counts with the same ATTENTION list, which is the point.
  function countStatuses(d) {
    const f = (d && d.findings) || {};
    let found = 0, attention = 0, total = 0;
    for (const v of Object.values(f)) {
      total++;
      if (v.status === STATUS.FOUND) found++;
      if (ATTENTION.includes(v.status || STATUS.UNSET)) attention++;
    }
    return { found, attention, total };
  }

  function persistBatch() {
    try {
      if (state.batch && state.batch.keys && state.batch.keys.length) localStorage.setItem(LS_BATCH, JSON.stringify(state.batch));
      else localStorage.removeItem(LS_BATCH);
    } catch (_) {}
  }

  // Highlight the chip for the currently-open site (or none if it isn't in the
  // batch). Called from loadSite so switching sites keeps the tray in sync.
  function syncBatchActive() {
    if (!state.batch || !state.site) return;
    const key = siteKey(state.site);
    state.batch.active = state.batch.keys.includes(key) ? key : null;
    persistBatch();
    renderBatchBar();
  }

  function loadSiteFromBatch(key) {
    const site = siteFromKey(key);
    if (!site) { toast("That site's saved data is no longer available"); return; }
    loadSite(site); // restores + renders; syncBatchActive highlights the chip
  }

  // Drop the batch membership. Site work stays in localStorage unless deleteSiteData.
  function clearBatch(deleteSiteData) {
    if (state.batch && deleteSiteData) {
      state.batch.keys.forEach((k) => {
        try { localStorage.removeItem(LS_PREFIX + k); localStorage.removeItem(LS_PREFIX + k + IMG_SUFFIX); } catch (_) {}
      });
    }
    state.batch = null;
    persistBatch();
    renderBatchBar();
  }

  function renderBatchBar() {
    const bar = $("#batch-bar");
    if (!bar) return;
    const tray = $("#batch-tray");
    if (!state.batch || !state.batch.keys.length) { bar.hidden = true; if (tray) tray.innerHTML = ""; return; }
    bar.hidden = false;
    const cnt = $("#batch-count");
    if (cnt) cnt.textContent = `· ${state.batch.keys.length} site${state.batch.keys.length > 1 ? "s" : ""}`;
    tray.innerHTML = "";
    state.batch.keys.forEach((key) => {
      const d = readSitePayload(key);
      const name = (d && d.site && d.site.name) || key;
      const c = countStatuses(d);
      const meta = el("span", { class: "batch-chip-meta" });
      if (c.found) meta.append(el("span", { class: "bc found", title: `${c.found} found` }, `⚑ ${c.found}`));
      if (c.attention) meta.append(el("span", { class: "bc attn", title: `${c.attention} still need you` }, `⚠ ${c.attention}`));
      if (!c.found && !c.attention && c.total) meta.append(el("span", { class: "bc ok", title: "nothing outstanding" }, "✓"));
      tray.append(el("button", {
        class: "batch-chip" + (key === state.batch.active ? " is-active" : ""),
        title: `Open ${name}`, onclick: () => loadSiteFromBatch(key),
      }, el("span", { class: "batch-chip-name" }, name), meta));
    });
  }

  function restoreBatch() {
    let b = null;
    try { b = JSON.parse(localStorage.getItem(LS_BATCH) || "null"); } catch (_) {}
    if (!b || !Array.isArray(b.keys) || !b.keys.length) return;
    // Keep only keys whose per-site data still exists.
    b.keys = b.keys.filter((k) => localStorage.getItem(LS_PREFIX + k) != null);
    if (!b.keys.length) { clearBatch(false); return; }
    if (!b.keys.includes(b.active)) b.active = b.keys[0];
    state.batch = b;
    renderBatchBar();
    const site = siteFromKey(b.active);
    if (site) loadSite(site, { focus: false }); // resume where the user left off — silently, on boot
  }

  // ------------------------------------------------------------- focus trap
  // Everything with role="dialog" and aria-modal="true" in this app — the batch
  // builder, the photo lightbox, the Queensland Globe modal — told assistive tech
  // it was modal and then wasn't: Tab walked straight out of the dialog and into
  // the page underneath, which is covered by a scrim and so is inert to the eye
  // but not to the keyboard. Focus vanished behind the overlay with nothing to say
  // where it had gone, and closing the dialog dropped it on <body>, so the next
  // Tab restarted from the top of the document rather than from the control that
  // opened the thing.
  //
  // trapFocus() fixes both halves: Tab and Shift+Tab wrap inside the dialog, and
  // the returned release() hands focus back to whatever opened it. Escape is
  // deliberately NOT handled here — all three dialogs already own their key
  // handling (the map modal's Escape closes its layer probe before the modal, and
  // the lightbox's also drives zoom), and a second handler would fight them.
  //
  // Exposed on window because assets/qldmap.js is a separate module with the same
  // problem; it is only ever opened from in here, so app.js has always run first.
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
    ' textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

  function trapFocus(dialog) {
    if (!dialog) return () => {};
    const opener = document.activeElement;
    // Ids survive a re-render; nodes do not. A dialog can rebuild the surface that
    // opened it while it is still up — capturing a Queensland Globe map writes a
    // finding, which repaints the very step carrying "Open site map" — and by the
    // time the dialog closes the opener is a detached node.
    const openerId = opener && opener.id;
    const onKey = (e) => {
      if (e.key !== "Tab" || e.defaultPrevented) return;
      // Re-read every time: these dialogs grow and shrink as you use them (the
      // batch builder's chips, the map's layer groups), so a list cached on open
      // goes stale immediately. getClientRects() rather than offsetParent —
      // offsetParent is null inside a position:fixed overlay.
      const items = $$(FOCUSABLE, dialog).filter((n) => n.getClientRects().length);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      // The `!dialog.contains` arms matter as much as the ends: clicking the
      // backdrop leaves activeElement on <body>, and without them the next Tab
      // would land in the page behind rather than back in the dialog.
      const here = document.activeElement;
      if (e.shiftKey ? (here === first || !dialog.contains(here)) : (here === last || !dialog.contains(here))) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    // Capture, so a dialog's own keydown handlers don't get to swallow Tab first.
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      restoreFocusAfterDialog(opener, openerId);
    };
  }

  // Where focus goes when a dialog closes. In order: the opener, if it is still
  // there; the node that replaced it, if it was re-rendered underneath; and
  // failing both, the heading of the step the operator is standing on.
  //
  // Never nothing. Focusing a detached node silently drops focus on <body>, which
  // is the same as losing it — the next Tab restarts from the top bar and a screen
  // reader is left with no idea where it is. That was the whole point of the trap.
  function restoreFocusAfterDialog(opener, openerId) {
    if (opener && document.contains(opener) && opener.focus) { opener.focus(); return; }
    const again = openerId && document.getElementById(openerId);
    if (again && again.focus) { again.focus(); return; }
    const heading = focusLive() && $("#fx-title");
    if (heading) heading.focus();
  }
  window.ESSFocusTrap = trapFocus;

  // -------------------------------------------------- batch builder (modal)
  // In-browser multi-site picker: search + add stations (or paste a list), then
  // "Start batch" hands the collected site objects to createBatchFromSites.
  let bbSel = [];          // selected site objects, in add order
  let bbAcMatches = [], bbAcIndex = -1;
  let bbRelease = null;    // trapFocus() teardown while the dialog is open

  function openBatchBuilder() {
    bbSel = [];
    const ov = $("#batch-builder");
    if (!ov) return;
    $("#bb-search").value = "";
    $("#bb-results").hidden = true;
    $("#bb-paste-text").value = "";
    const pm = $("#bb-paste-msg"); if (pm) { pm.hidden = true; pm.textContent = ""; }
    bbRenderSelected();
    ov.hidden = false;
    ov.classList.add("show");
    bbRelease = trapFocus(ov.querySelector(".bb-dialog"));
    setTimeout(() => $("#bb-search").focus(), 0);
  }
  function closeBatchBuilder() {
    const ov = $("#batch-builder");
    if (!ov) return;
    ov.classList.remove("show");
    ov.hidden = true;
    $("#bb-results").hidden = true;
    // Releases the Tab trap and puts focus back on "Batch multiple sites".
    if (bbRelease) { bbRelease(); bbRelease = null; }
  }

  function bbChipMeta(site) {
    const bits = [site.state || "?"];
    if (site.station_num) bits.push("#" + site.station_num);
    else bits.push(`${(+site.lat).toFixed(3)}, ${(+site.lon).toFixed(3)}`);
    return bits.join(" · ");
  }

  function bbRenderSelected() {
    const wrap = $("#bb-chips");
    if (!wrap) return;
    wrap.innerHTML = "";
    const cnt = $("#bb-count");
    if (cnt) cnt.textContent = bbSel.length ? `· ${bbSel.length}` : "";
    const clearBtn = $("#bb-clear-sel");
    if (clearBtn) clearBtn.hidden = !bbSel.length;
    const createBtn = $("#bb-create");
    if (createBtn) {
      createBtn.disabled = !bbSel.length;
      createBtn.textContent = bbSel.length ? `Start batch (${bbSel.length})` : "Start batch";
    }
    if (!bbSel.length) {
      wrap.append(el("p", { class: "bb-empty", id: "bb-empty" }, "No sites yet — search or paste above to add some."));
      return;
    }
    bbSel.forEach((site) => {
      const key = siteKey(site);
      wrap.append(el("span", { class: "bb-chip" },
        el("span", { class: "bb-chip-name", title: site.name }, site.name),
        el("span", { class: "bb-chip-meta" }, bbChipMeta(site)),
        el("button", { class: "bb-chip-x", type: "button", title: "Remove", "aria-label": `Remove ${site.name}`,
          onclick: () => bbRemove(key) }, "✕")));
    });
  }

  // Add a resolved site to the selection. Returns true only if newly added (a
  // duplicate by siteKey is ignored). `silent` suppresses the per-add toast/render
  // for bulk (paste) adds, which render once at the end.
  function bbAdd(site, silent) {
    if (!site || !isFinite(site.lat) || !isFinite(site.lon)) return false;
    const key = siteKey(site);
    if (bbSel.some((s) => siteKey(s) === key)) { if (!silent) toast(`${site.name} is already in the list`); return false; }
    bbSel.push(site);
    if (!silent) bbRenderSelected();
    return true;
  }
  function bbRemove(key) {
    bbSel = bbSel.filter((s) => siteKey(s) !== key);
    bbRenderSelected();
  }

  // Resolve one pasted line to a site object: a decimal `lat,lon[,name]`, else an
  // exact station number, else an exact station name, else the best name match.
  function bbResolveLine(line) {
    const raw = (line || "").trim();
    if (!raw) return null;
    const parts = raw.split(",").map((x) => x.trim());
    if (parts.length >= 2 && isFinite(Number(parts[0])) && isFinite(Number(parts[1])) &&
        Math.abs(Number(parts[0])) <= 90 && Math.abs(Number(parts[1])) <= 180) {
      const lat = Number(parts[0]), lon = Number(parts[1]);
      return coordToSite(lat, lon, parts.slice(2).join(", "), stateFromCoords(lat, lon));
    }
    const byNum = DATA.stations.find((s) => String(s.station_num) === raw);
    if (byNum) return stationToSite(byNum);
    const low = raw.toLowerCase();
    const exact = DATA.stations.find((s) => s.name.toLowerCase() === low);
    if (exact) return stationToSite(exact);
    const matches = searchStations(raw);
    return matches.length ? stationToSite(matches[0]) : null;
  }

  function bbAddPaste() {
    const ta = $("#bb-paste-text");
    const lines = (ta.value || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let added = 0;
    const unresolved = [];
    lines.forEach((line) => {
      const site = bbResolveLine(line);
      if (site && bbAdd(site, true)) added++;
      else if (!site) unresolved.push(line);
    });
    bbRenderSelected();
    ta.value = unresolved.join("\n"); // keep only the lines we couldn't place, to fix
    const msg = $("#bb-paste-msg");
    if (msg) {
      const bits = [];
      if (added) bits.push(`Added ${added} site${added > 1 ? "s" : ""}`);
      if (unresolved.length) bits.push(`couldn't match ${unresolved.length} line${unresolved.length > 1 ? "s" : ""} (left above)`);
      msg.textContent = bits.join(" · ") || "Nothing to add.";
      msg.hidden = false;
      msg.classList.toggle("err", unresolved.length > 0 && !added);
    }
  }

  // Autocomplete inside the modal — mirrors the main station search but each pick
  // adds to the selection (and clears the box) instead of loading the site.
  function bbRenderAc(matches) {
    const ul = $("#bb-results");
    ul.innerHTML = "";
    bbAcMatches = matches; bbAcIndex = -1;
    if (!matches.length) { ul.hidden = true; return; }
    matches.forEach((s, i) => {
      ul.append(el("li", { "data-i": i, onmousedown: (e) => { e.preventDefault(); bbPick(s); } },
        el("span", { class: "ac-name" }, s.name),
        el("span", { class: "ac-meta" }, `${s.state || "?"} · ${(s.facility_types[0] || s.primary_facility || "site")}${s.station_num ? " · " + s.station_num : ""}`)));
    });
    ul.hidden = false;
  }
  function bbPick(s) {
    bbAdd(stationToSite(s));
    const input = $("#bb-search");
    input.value = "";
    $("#bb-results").hidden = true;
    input.focus();
  }
  function bbStartBatch() {
    if (!bbSel.length) { toast("Add at least one site first"); return; }
    const sites = bbSel.slice();
    closeBatchBuilder();
    createBatchFromSites(sites);
  }

  function wireBatchBuilder() {
    const openBtn = $("#btn-open-batch");
    if (openBtn) openBtn.addEventListener("click", openBatchBuilder);
    const ov = $("#batch-builder");
    if (!ov) return;
    $("#bb-close").addEventListener("click", closeBatchBuilder);
    $("#bb-cancel").addEventListener("click", closeBatchBuilder);
    ov.addEventListener("click", (e) => { if (e.target === ov) closeBatchBuilder(); }); // backdrop
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && ov.classList.contains("show")) closeBatchBuilder(); });
    $("#bb-create").addEventListener("click", bbStartBatch);
    $("#bb-clear-sel").addEventListener("click", () => { bbSel = []; bbRenderSelected(); });
    $("#bb-paste-add").addEventListener("click", bbAddPaste);

    const search = $("#bb-search");
    search.addEventListener("input", () => bbRenderAc(searchStations(search.value)));
    search.addEventListener("focus", () => { if (search.value) bbRenderAc(searchStations(search.value)); });
    search.addEventListener("keydown", (e) => {
      const ul = $("#bb-results");
      if (e.key === "Enter") {
        e.preventDefault();
        if (!ul.hidden && bbAcIndex >= 0) bbPick(bbAcMatches[bbAcIndex]);
        else if (bbAcMatches.length) bbPick(bbAcMatches[0]); // Enter adds the top match
        return;
      }
      if (ul.hidden) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        bbAcIndex += e.key === "ArrowDown" ? 1 : -1;
        bbAcIndex = Math.max(0, Math.min(bbAcMatches.length - 1, bbAcIndex));
        $$("#bb-results li").forEach((li, i) => li.classList.toggle("active", i === bbAcIndex));
      } else if (e.key === "Escape") { ul.hidden = true; }
    });
    search.addEventListener("blur", () => setTimeout(() => { $("#bb-results").hidden = true; }, 120));
  }

  // The document header's "Export ▾" menu — every way this report leaves the app,
  // in one control, handover format first. Same pattern, and the same keyboard
  // behaviour, as every card's ⋯.
  function wireOverflowMenu() {
    const menu = $("#report-export-menu");
    if (!menu) return;
    const toggle = $("#btn-report-export");
    const list = menu.querySelector(".menu-list");
    const setOpen = (open) => { list.hidden = !open; toggle.setAttribute("aria-expanded", open ? "true" : "false"); };
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = list.hidden;
      setOpen(open);
      if (open) focusFirstMenuItem(list);
    });
    list.addEventListener("click", () => setOpen(false)); // close after choosing an item
    wireMenuKeys(toggle, list, setOpen);
    document.addEventListener("click", (e) => { if (!menu.contains(e.target)) setOpen(false); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });
    // The same two gestures for every source card's ⋯ menu. Registered once, here,
    // rather than per card: cards are rebuilt on every status tick, and per-card
    // document listeners would accumulate against detached nodes.
    document.addEventListener("click", (e) => { if (!e.target.closest || !e.target.closest(".card-menu")) closeCardMenus(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCardMenus(); });
  }

  // Step 3: run the auto-checks, copy the prompt, paste the reply back. The copy
  // and the paste box sit in the same card on purpose — the round trip out to an
  // assistant and back is the primary workflow, and it shouldn't need a scroll.
  function wireStepThree() {
    const run = $("#btn-run-auto");
    if (run) run.addEventListener("click", runAllAuto);
    const copyBtn = $("#btn-copy-prompt");
    if (copyBtn) copyBtn.addEventListener("click", (e) => {
      copyFullPrompt(e).then((ok) => {
        setFlowStatus("#prompt-status", ok
          ? "Copied — paste it into your assistant, then bring its reply back below."
          : "The browser blocked the copy. Try again, or use JSON export (under More) and work from that.", ok ? "ok" : "err");
        if (ok) markFlowDone("prompt", "Prompt copied"); // a copy that failed hasn't advanced anything
      });
    });
    const apply = $("#btn-paste-apply");
    if (apply) apply.addEventListener("click", applyPastedJson);
    const clear = $("#btn-paste-clear");
    if (clear) clear.addEventListener("click", () => {
      clearTimeout(pastePreviewTimer);
      const box = $("#paste-json");
      if (box) { box.value = ""; box.focus(); }
      setFlowStatus("#paste-status", "");
    });
    const box = $("#paste-json");
    if (box) {
      box.addEventListener("input", () => {
        clearTimeout(pastePreviewTimer);
        pastePreviewTimer = setTimeout(previewPastedJson, 250);
      });
      // Ctrl/Cmd+Enter applies, so a paste can be finished without reaching for the mouse.
      box.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); applyPastedJson(); }
      });
    }

    // A folded sub-step keeps its action one click away: Re-run and Copy again do
    // the thing (and unfold, so the status has somewhere to land); the paste step
    // can only be re-opened, since there is nothing to apply until something is in
    // the box.
    $$("[data-flow-again]").forEach((btn) => btn.addEventListener("click", () => {
      const key = btn.dataset.flowAgain;
      openFlowStep(key);
      if (key === "auto") runAllAuto();
      else if (key === "prompt") $("#btn-copy-prompt").click();
      else if (box) box.focus();
    }));
    // …and the finished card as a whole folds to its receipt line, expandable.
    const rcToggle = $("#btn-run-checks-toggle");
    if (rcToggle) rcToggle.addEventListener("click", () => setRunChecksOpen($("#run-checks-body").hidden));
  }

  // Step 2's header controls: the Details disclosure, the copyable coordinates and
  // the photo count (which is also the way into the dropzone), plus the paste route
  // that has to keep working while the panel is shut.
  function wireSiteDetails() {
    const toggle = $("#btn-site-details");
    if (toggle) toggle.addEventListener("click", () => setSiteDetailsOpen($("#site-details").hidden));
    const coords = $("#sd-coords");
    if (coords) coords.addEventListener("click", () => {
      if (state.site) copy(`${state.site.lat}, ${state.site.lon}`, "Coordinates copied");
    });
    const photos = $("#sd-photo-count");
    if (photos) photos.addEventListener("click", () => setSiteDetailsOpen(true, "#site-dropzone"));

    // The station-record correction. Wired here, on the nodes themselves, so Focus
    // mode's site-details step gets the same behaviour by borrowing the block —
    // there is no second copy of these fields to keep in step.
    SITE_CORRECT_FIELDS.forEach((field) => {
      const inp = $(field.sel);
      // change (not input): a half-typed station name should not repaint the header
      // and the report's front page on every keystroke.
      if (inp) inp.addEventListener("change", (e) => correctSiteField(field, e.target.value));
    });
    const stateSel = $("#fld-site-state");
    if (stateSel) stateSel.addEventListener("change", (e) => correctSiteState(e.target.value));

    // A screenshot pasted anywhere on the page — with the details panel shut, or
    // with nothing focused at all — is a station photo. The zone-level listeners
    // (the site dropzone, each card's evidence zone) run first and call
    // preventDefault, so this only ever picks up the pastes nothing else claimed,
    // and never one aimed at a text field (the step-3 JSON box included).
    document.addEventListener("paste", (e) => {
      if (e.defaultPrevented || !state.site || $("#workspace").hidden) return;
      const t = e.target;
      // Text fields keep their own paste; a zone that takes photos has already
      // had its go; and a paste inside one of the modals belongs to that modal.
      if (t && t.closest && t.closest("input, textarea, select, [contenteditable=''], [contenteditable=true], .dropzone, .qm-overlay, .bb-overlay")) return;
      const files = filesFromClipboard(e);
      if (!files.length) return;
      e.preventDefault();
      // …unless Focus is showing a source step, in which case the screen the paste
      // was aimed at is that source, and its evidence is where it belongs.
      const onSource = focusPasteSourceId();
      if (onSource) {
        addFindingImages(onSource, files);
        toast(files.length > 1 ? `${files.length} photos added to this source` : "Photo added to this source");
        return;
      }
      addSiteImages(files);
      toast(files.length > 1 ? `${files.length} photos added to the site` : "Photo added to the site");
    });
  }

  // The Advanced options disclosure at the foot of the left column — batching,
  // file import, agent mode, display preferences. Closed by default so the four
  // numbered steps are all a first-time operator sees; the choice is remembered.
  function wireAdvancedPanel() {
    const adv = $("#advanced");
    if (!adv) return;
    try { if (localStorage.getItem(LS_ADVANCED) === "1") adv.open = true; } catch (_) {}
    adv.addEventListener("toggle", () => {
      try { localStorage.setItem(LS_ADVANCED, adv.open ? "1" : "0"); } catch (_) {}
    });
  }

  // Advanced options → "Import a findings file". The paste route lives in step 3
  // (applyPastedJson); both meet at routeImport.
  function doImport() {
    const input = $("#import-file");
    const file = input && input.files && input.files[0];
    if (!file) { alert("Choose a findings file first."); return; }
    const r = new FileReader();
    r.onload = () => {
      const json = extractJsonPayload(String(r.result));
      if (!json) { alert("Import failed: that file isn't valid JSON."); return; }
      try {
        if (routeImport(json) === "site") toast("Findings imported");
        input.value = ""; // so re-picking the same file fires a fresh change
      } catch (err) { alert("Import failed: " + err.message); }
    };
    r.onerror = () => alert("Could not read the file.");
    r.readAsText(file);
  }

  const slug = (s) => s.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").slice(0, 40);
  // Resolves true once the text is on the clipboard, false if the browser refused
  // (no clipboard API, or permission denied on an insecure origin) — callers that
  // report "copied" need to know which happened.
  function copy(text, msg) {
    if (!navigator.clipboard) { toast("Copy not available"); return Promise.resolve(false); }
    return navigator.clipboard.writeText(text)
      .then(() => { toast(msg || "Copied"); return true; })
      .catch(() => { toast("Couldn't copy — select the text and copy it by hand"); return false; });
  }
  let toastTimer;
  // Every "Copied", "Findings imported" and "Map added to the report" in the app
  // comes through here, and until it carried a live region all of them were
  // silent: the one confirmation that a copy actually reached the clipboard was
  // visible for 1.4 seconds and announced never.
  //
  // role="status" (polite) rather than "alert": these are confirmations of
  // something the operator just did, so they wait for a gap rather than cutting
  // across whatever is being read. The node is created empty and filled after,
  // because a live region only announces changes made while it is in the
  // document — building it with the text already in it announces nothing.
  function toast(msg) {
    let t = $("#toast");
    if (!t) {
      t = el("div", { id: "toast", role: "status", "aria-live": "polite",
        style: "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#17242e;color:#fff;padding:9px 16px;border-radius:8px;z-index:99;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.3)" });
      document.body.append(t);
    }
    t.textContent = msg; t.style.opacity = "1";
    // Only the tint fades — clearing the text would re-fire the live region with
    // an empty string on every toast.
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.opacity = "0"; }, 1400);
  }

  // ---------------------------------------------------------------- theme
  // Light / dark switch. The saved choice is applied before first paint by the
  // inline script in index.html (avoids a flash); this keeps the toggle button
  // label in sync and lets the user flip it. With no explicit choice we follow
  // the OS setting via prefers-color-scheme (handled in CSS).
  const LS_THEME = "ess-workbench:v1:theme";
  function themeIsDark() {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark") return true;
    if (attr === "light") return false;
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  function syncThemeButton() {
    const btn = $("#btn-theme");
    if (!btn) return;
    const dark = themeIsDark();
    btn.textContent = dark ? "Light" : "Dark";
    btn.title = dark ? "Switch to light theme" : "Switch to dark theme";
  }
  function toggleTheme() {
    const next = themeIsDark() ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem(LS_THEME, next); } catch (_) {}
    syncThemeButton();
  }

  // ---------------------------------------------------------------- layout metrics
  // The two independently-scrolling columns are sized to the viewport height minus
  // the sticky top bar; measure that bar (and keep it current on resize) into a
  // CSS variable the stylesheet reads.
  function measureTopbar() {
    const tb = $(".topbar");
    if (tb) document.documentElement.style.setProperty("--topbar-h", tb.offsetHeight + "px");
  }

  // The collection bar pins to the top of the left column, so its height is what
  // the sticky group headers (and scroll-to-section) have to clear. It changes
  // whenever the sentence rewraps or the Results panel opens, so it's measured
  // rather than assumed; 0 while no site is loaded, which parks the group headers
  // back at the top of the column.
  function measureStatusBar() {
    const card = $("#collection-status");
    const h = card && card.offsetParent ? card.offsetHeight : 0;
    document.documentElement.style.setProperty("--status-h", h + "px");
  }

  // Same job on the right: the document header pins to the top of the report
  // pane, so its height is what "go to this section" has to scroll clear of —
  // otherwise every jump lands the section heading underneath the header.
  function measureReportHeader() {
    const head = $("#report .rdoc");
    const h = head && head.offsetParent ? head.offsetHeight : 0;
    document.documentElement.style.setProperty("--rdoc-h", h + "px");
  }

  // Square off the pinned collection bar against the topbar once it's actually
  // stuck (CSS alone can't tell). Cheap enough to run per scroll frame.
  function syncProgressPinned() {
    const col = $("#col-left"), card = $("#collection-status");
    if (!col || !card || !card.offsetParent) return;
    const stuck = card.getBoundingClientRect().top <= col.getBoundingClientRect().top + 0.5;
    card.classList.toggle("is-pinned", stuck);
  }

  // ---------------------------------------------------------------- pane focus
  // Either column can be collapsed so the other takes the full width — for reading
  // a long report, or for working the dashboard without the report alongside. Only
  // one at a time: collapsing the second would leave nothing on screen, so asking
  // for it just moves the collapse to that side.
  const LS_PANE = LS_PREFIX + "pane";
  // Single chevron = collapse this side (pointing the way it folds away); double
  // chevron = bring it back. The two glyphs have to differ at a glance, since a
  // collapsed pane leaves its own handle sitting right beside the other one.
  const PANE_SIDES = [
    { btn: "#btn-pane-left", mode: "hide-left", name: "collection", hide: "◀", show: "»" },
    { btn: "#btn-pane-right", mode: "hide-right", name: "report", hide: "▶", show: "«" },
  ];
  let paneMode = "split"; // "split" | "hide-left" | "hide-right"

  function setPaneMode(mode, persist = true) {
    paneMode = mode === "hide-left" || mode === "hide-right" ? mode : "split";
    const split = $(".split");
    if (split) {
      split.classList.toggle("pane-hide-left", paneMode === "hide-left");
      split.classList.toggle("pane-hide-right", paneMode === "hide-right");
    }
    for (const side of PANE_SIDES) {
      const btn = $(side.btn);
      if (!btn) continue;
      const collapsed = paneMode === side.mode;
      btn.textContent = collapsed ? side.show : side.hide;
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      const label = collapsed
        ? `Show the ${side.name} pane again`
        : `Hide the ${side.name} pane — give the other side the full width`;
      btn.title = label;
      btn.setAttribute("aria-label", label);
    }
    if (persist) { try { localStorage.setItem(LS_PANE, paneMode); } catch (_) {} }
    syncSyncButton();
  }

  // Anything that lives in the left column and can be summoned from outside it
  // (the agent panel, from the topbar key button) has to bring the column back
  // first, or it opens into a hidden pane. Below 981px "hidden" means the other
  // tab is showing, so both layouts are handled in the one call — every existing
  // cross-pane jump keeps working on a phone without knowing about tabs.
  function revealLeftPane() { if (paneMode === "hide-left") setPaneMode("split"); showMobileTab("collect"); }
  // …and the same for the report, so an include receipt, a starved-section name
  // or the card's "Show in the report" never points into a collapsed pane.
  function revealRightPane() { if (paneMode === "hide-right") setPaneMode("split"); showMobileTab("report"); }

  // ---------------------------------------------------------------- narrow layout
  // Below 981px the panes are tabs rather than a stack (see .mshell in the CSS).
  // Two things make that a real switch and not just a hide: each tab keeps its own
  // scroll position, and the tab you are not on still tells you what it is holding
  // — the outstanding count on Collect, the site name on both.
  const NARROW_MQ = "(max-width: 980px)";
  const narrowLayout = () => !!(window.matchMedia && window.matchMedia(NARROW_MQ).matches);
  const M_TABS = [
    { tab: "collect", btn: "#mtab-collect", col: "col-left" },
    { tab: "report", btn: "#mtab-report", col: "col-right" },
  ];
  let mTab = "collect";
  // Page scroll offsets, one per tab. Switching without these lands you at
  // whatever offset the other pane happened to be at — on a 6,000px report that
  // is worse than the stack it replaced.
  const mScroll = { collect: 0, report: 0 };
  // Whether the tabs are in play at all: they need a site, and a narrow window.
  const mShellLive = () => { const s = $("#mshell"); return !!s && !s.hidden; };

  function setMobileTab(tab, { remember = true } = {}) {
    tab = tab === "report" ? "report" : "collect";
    const live = mShellLive();
    if (live && remember && narrowLayout()) mScroll[mTab] = window.scrollY;
    const changed = tab !== mTab;
    mTab = tab;
    const split = $(".split");
    if (split) {
      split.classList.toggle("mtab-collect", live && mTab === "collect");
      split.classList.toggle("mtab-report", live && mTab === "report");
    }
    for (const t of M_TABS) {
      const btn = $(t.btn);
      if (!btn) continue;
      const on = t.tab === mTab;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
      // Roving tabindex: the tablist is one tab stop, arrows move within it.
      btn.tabIndex = on ? 0 : -1;
    }
    // The category jumps belong to the collection pane's structure; on the report
    // tab they would scroll a pane that isn't on screen.
    const jump = $("#mjump");
    if (jump) jump.hidden = mTab !== "collect" || !jump.childElementCount;
    if (live && changed && narrowLayout()) restoreMobileScroll(mScroll[mTab] || 0);
    measureMobileShell();
  }

  // The pane being switched to was display:none until a line ago. Its height is in
  // the layout tree immediately, but the scrollable area behind it is not always
  // resized in time for a synchronous scrollTo to land — a restore deep into a
  // long pane silently clamps to 0. So ask once now (correct in the common case,
  // and no visible jump) and again on the next frame, once layout has settled.
  function restoreMobileScroll(top) {
    window.scrollTo({ top, behavior: "auto" });
    requestAnimationFrame(() => window.scrollTo({ top, behavior: "auto" }));
  }

  // Used by revealLeftPane / revealRightPane: bring a tab forward, but never
  // record the scroll position of a jump we are about to overwrite anyway.
  function showMobileTab(tab) {
    if (!narrowLayout() || !mShellLive() || mTab === tab) return;
    setMobileTab(tab);
  }

  // The shell's height is the second sticky band a jump has to clear (--topbar-h
  // is the first), so the stylesheet reads it the same way.
  function measureMobileShell() {
    const shell = $("#mshell");
    const h = shell && shell.offsetParent ? shell.offsetHeight : 0;
    document.documentElement.style.setProperty("--mshell-h", h + "px");
  }

  // Built from the same three sources the wide layout uses — the site record, the
  // dashboard's category order and railAttentionCounts() — so the two navigations
  // can never disagree about what is left.
  function renderMobileNav() {
    const shell = $("#mshell");
    if (!shell) return;
    // The tabs exist to switch between the two panes; Focus mode has neither.
    const live = workbenchLive() && !!state.site && !$("#workspace").hidden;
    shell.hidden = !live;
    if (!live) {
      // No site: no tabs, and the two panes go back to stacking (picker above,
      // report placeholder below), which is the right shape for that state.
      const split = $(".split");
      if (split) split.classList.remove("mtab-collect", "mtab-report");
      measureMobileShell();
      return;
    }

    const s = state.site;
    $("#msite-name").textContent = s.name || "";
    $("#msite-ids").textContent = [s.station_num && `#${s.station_num}`, s.state].filter(Boolean).join(" · ");

    const catById = {};
    for (const c of (DATA.sourcesMeta && DATA.sourcesMeta.categories) || []) catById[c.id] = c;
    const attention = railAttentionCounts();
    const jump = $("#mjump");
    jump.replaceChildren(...dashboardCats.map((id) => {
      const cat = catById[id];
      if (!cat) return null;
      const n = attention[id] || 0;
      // .hidden as a property, not an attribute: el() would write hidden="false"
      // for a category with something outstanding, and any hidden attribute hides.
      const count = el("span", { class: "mjump-count", "aria-hidden": "true" }, `${n}`);
      count.hidden = !n;
      const btn = el("button", {
        type: "button", class: "mjump-btn", "data-target": `group-${id}`, "data-cat": id,
        onclick: () => railScrollTo(`group-${id}`),
      }, el("span", { class: "mjump-glyph", "aria-hidden": "true" }, CAT_GLYPH[id] || "•"),
         el("span", {}, cat.label), count);
      btn.style.setProperty("--cat", `var(--cat-${id})`);
      setMobileJumpLabel(btn, cat.label, n);
      return btn;
    }).filter(Boolean));

    setMobileTab(mTab, { remember: false });
    refreshMobileNav();
  }

  // Same wording as the rail's tooltip, for the same reason: the count is a badge
  // for the eye, so the accessible name has to state it in words.
  function setMobileJumpLabel(btn, label, n) {
    btn.setAttribute("aria-label", label + (n ? ` — ${n} still need you` : ""));
  }

  // Count-only refresh, run from renderCollectionStatus() beside refreshRailBadges()
  // so every path that changes a result keeps both navigations live.
  function refreshMobileNav() {
    if (!mShellLive()) return;
    const c = statusCounts();
    const badge = $("#mtab-badge");
    if (badge) {
      badge.hidden = !c.outstanding;
      badge.textContent = c.outstanding ? `${c.outstanding}` : "";
    }
    const collect = $("#mtab-collect");
    if (collect) collect.setAttribute("aria-label",
      c.outstanding ? `Collect — ${c.outstanding} of ${c.n} still need you` : "Collect — nothing outstanding");
    const catById = {};
    for (const cat of (DATA.sourcesMeta && DATA.sourcesMeta.categories) || []) catById[cat.id] = cat;
    const attention = railAttentionCounts();
    $$("#mjump .mjump-btn").forEach((btn) => {
      const cat = catById[btn.dataset.cat];
      if (!cat) return;
      const n = attention[btn.dataset.cat] || 0;
      const count = btn.querySelector(".mjump-count");
      if (count) { count.hidden = !n; count.textContent = n ? `${n}` : ""; }
      setMobileJumpLabel(btn, cat.label, n);
    });
    measureMobileShell();
  }

  // The columns are only tab panels while the tabs exist. Announcing them as
  // panels on the wide layout — where both are on screen at once and there is no
  // tablist — would be a lie to assistive tech, so the roles come and go with the
  // breakpoint.
  function syncNarrowRoles() {
    const narrow = narrowLayout();
    for (const t of M_TABS) {
      const col = document.getElementById(t.col);
      if (!col) continue;
      if (narrow) { col.setAttribute("role", "tabpanel"); col.setAttribute("aria-labelledby", t.btn.slice(1)); }
      else { col.removeAttribute("role"); col.removeAttribute("aria-labelledby"); }
    }
    if (!narrow) setTopbarMenuOpen(false);
    measureMobileShell();
    // The scroll-spy is bound to one layout's scroll container — rebuild both
    // navigations so it re-binds to the one now in force.
    renderRailNav();
  }

  // The topbar's ⋯ popover — the same three controls the wide layout shows inline.
  function setTopbarMenuOpen(open) {
    const menu = $("#topbar-meta"), btn = $("#btn-topbar-more");
    if (!menu || !btn) return;
    menu.classList.toggle("open", !!open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  // ---------------------------------------------------------------- scroll sync
  // Optional: keep the two panes roughly aligned by report section while
  // scrolling, so the report stays on whatever the collection pane is showing
  // (and back again). Off by default — it moves a pane the operator did not
  // touch, which has to be asked for — and the choice is remembered.
  const LS_SYNC = LS_PREFIX + "panesync";
  let scrollSync = false;
  let syncLock = 0; // ms: ignore scroll events until then, they are our own doing

  const wideLayout = () => !window.matchMedia || window.matchMedia("(min-width: 981px)").matches;
  // Nothing to align when a pane is collapsed, or when the layout has stacked the
  // two columns into one page scroll.
  const syncActive = () => scrollSync && paneMode === "split" && wideLayout();

  function setScrollSync(on, persist = true) {
    scrollSync = !!on;
    if (persist) { try { localStorage.setItem(LS_SYNC, scrollSync ? "1" : "0"); } catch (_) {} }
    syncSyncButton();
    if (syncActive()) alignPanes("left");
  }

  function syncSyncButton() {
    const btn = $("#btn-pane-sync");
    if (!btn) return;
    btn.classList.toggle("on", scrollSync);
    btn.setAttribute("aria-pressed", scrollSync ? "true" : "false");
    // A pane is collapsed: the control has nothing to align, and says so rather
    // than sitting there lit and inert.
    const idle = paneMode !== "split";
    btn.disabled = idle;
    const label = idle
      ? "Linked scrolling — needs both panes open"
      : scrollSync
        ? "Linked scrolling is on — the panes follow each other by report section. Turn it off."
        : "Link the two panes' scrolling, so each follows the other by report section";
    btn.title = label;
    btn.setAttribute("aria-label", label);
  }

  // The topmost thing still in view in `col` that names a report section.
  function topSectionIn(col, sel) {
    const top = col.getBoundingClientRect().top;
    for (const node of $$(sel, col)) {
      if (!node.offsetParent) continue; // inside a folded group, or a hidden pane
      if (node.getBoundingClientRect().bottom > top + 4) return node.dataset.section || null;
    }
    return null;
  }

  function alignPanes(from) {
    if (!syncActive()) return;
    const now = Date.now();
    if (now < syncLock) return;
    const left = $("#col-left"), right = $("#col-right");
    if (!left || !right) return;
    const fromLeft = from === "left";
    const id = topSectionIn(fromLeft ? left : right, fromLeft ? ".src[data-section]" : ".rsection[data-section]");
    if (!id || !/^[\w-]+$/.test(id)) return;
    const target = fromLeft ? right : left;
    const node = fromLeft
      ? document.getElementById(`rsec-${id}`)
      : $$(`#col-left .src[data-section="${id}"]`).find((c) => c.offsetParent);
    if (!node || !node.offsetParent) return;
    // Land clear of whatever is pinned at the top of the target pane — the same
    // offset a jump uses (--rdoc-h on the right, --status-h on the left).
    const pad = parseFloat(getComputedStyle(target).scrollPaddingTop) || 0;
    const delta = node.getBoundingClientRect().top - target.getBoundingClientRect().top - pad;
    if (Math.abs(delta) < 8) return; // close enough — don't fight the operator's scroll
    syncLock = now + 180; // swallow the echo our own scroll is about to raise
    target.scrollTop += delta;
  }

  // ---------------------------------------------------------------- lightbox
  // One reusable full-screen overlay for viewing an image — a site/evidence photo
  // or the satellite locator map — with wheel/box-button zoom and drag to pan.
  // Replaces the old window.open(dataUrl) behaviour, which browsers render as a
  // blank page. Wikipedia reference photos instead open their source article
  // (decided in activateImage, since that's a real navigable page).
  let LB = null;
  let lbRelease = null; // trapFocus() teardown while the viewer is open
  function ensureLightbox() {
    if (LB) return LB;
    const img = el("img", { class: "lb-img", alt: "" });
    const stage = el("div", { class: "lb-stage" }, img);
    const cap = el("div", { class: "lb-cap" });
    const closeBtn = el("button", { class: "lb-close", "aria-label": "Close", title: "Close (Esc)", onclick: () => hideLightbox() }, "×");
    const zoomOut = el("button", { class: "lb-btn", title: "Zoom out", onclick: (e) => { e.stopPropagation(); zoomBy(1 / 1.3); } }, "−");
    const zoomReset = el("button", { class: "lb-btn", title: "Reset view", onclick: (e) => { e.stopPropagation(); resetLightboxView(); } }, "Reset");
    const zoomIn = el("button", { class: "lb-btn", title: "Zoom in", onclick: (e) => { e.stopPropagation(); zoomBy(1.3); } }, "+");
    const controls = el("div", { class: "lb-controls" }, zoomOut, zoomReset, zoomIn);
    const hint = el("div", { class: "lb-hint" }, "Scroll to zoom · drag to pan · double-click to toggle");
    // A modal in every respect except that it never said so: the scrim makes the
    // page behind inert to the eye, so it has to be inert to the keyboard too.
    const overlay = el("div", { class: "lb-overlay", id: "img-modal", role: "dialog",
      "aria-modal": "true", "aria-label": "Photo viewer" }, cap, closeBtn, controls, hint, stage);
    document.body.append(overlay);
    LB = { overlay, img, stage, cap, scale: 1, tx: 0, ty: 0, drag: null };
    LB.apply = () => { img.style.transform = `translate(${LB.tx}px, ${LB.ty}px) scale(${LB.scale})`; };

    stage.addEventListener("wheel", (e) => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });
    stage.addEventListener("pointerdown", (e) => {
      LB.drag = { x: e.clientX, y: e.clientY, tx: LB.tx, ty: LB.ty };
      stage.classList.add("grabbing");
      try { stage.setPointerCapture(e.pointerId); } catch (_) {}
    });
    stage.addEventListener("pointermove", (e) => {
      if (!LB.drag) return;
      LB.tx = LB.drag.tx + (e.clientX - LB.drag.x);
      LB.ty = LB.drag.ty + (e.clientY - LB.drag.y);
      LB.apply();
    });
    const endDrag = () => { LB.drag = null; stage.classList.remove("grabbing"); };
    stage.addEventListener("pointerup", endDrag);
    stage.addEventListener("pointercancel", endDrag);
    stage.addEventListener("dblclick", (e) => { e.preventDefault(); LB.scale > 1 ? resetLightboxView() : zoomBy(2.2); });
    // A click on the backdrop (or the empty stage) closes; a click on the image does not.
    overlay.addEventListener("click", (e) => { if (e.target === overlay || e.target === stage) hideLightbox(); });
    return LB;
  }
  function zoomBy(f) {
    const lb = ensureLightbox();
    lb.scale = Math.max(1, Math.min(8, lb.scale * f));
    if (lb.scale === 1) { lb.tx = 0; lb.ty = 0; }
    lb.apply();
  }
  function resetLightboxView() { const lb = ensureLightbox(); lb.scale = 1; lb.tx = 0; lb.ty = 0; lb.apply(); }
  function openLightbox(src, caption) {
    if (!src) return;
    const lb = ensureLightbox();
    lb.img.src = src;
    lb.cap.textContent = caption || "";
    lb.scale = 1; lb.tx = 0; lb.ty = 0; lb.apply();
    lb.overlay.classList.add("show");
    document.addEventListener("keydown", lbKeydown);
    // Before the trap, so it records the thumbnail that opened this as the node
    // to hand focus back to.
    lbRelease = trapFocus(lb.overlay);
    lb.overlay.querySelector(".lb-close").focus();
  }
  function hideLightbox() {
    if (!LB) return;
    LB.overlay.classList.remove("show");
    LB.img.src = "";
    document.removeEventListener("keydown", lbKeydown);
    if (lbRelease) { lbRelease(); lbRelease = null; } // …and back to the thumbnail
  }
  function lbKeydown(e) {
    if (e.key === "Escape") hideLightbox();
    else if (e.key === "+" || e.key === "=") zoomBy(1.3);
    else if (e.key === "-") zoomBy(1 / 1.3);
    else if (e.key === "0") resetLightboxView();
  }
  // What happens when a photo is clicked: a Wikipedia reference photo opens its
  // source article (a real page — the old blank-tab bug was opening a data: URL);
  // any other photo opens in the pan/zoom lightbox.
  function activateImage(im) {
    const href = safeHttpUrl(im && im.source_url);
    if (href) window.open(href, "_blank", "noopener");
    else if (im && im.dataUrl) openLightbox(im.dataUrl, im.caption || "");
  }

  // ---------------------------------------------------------------- wiring
  function wire() {
    wireTabs();
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
    // Pasting a combined "lat, lon" into either coordinate box splits the pair
    // across both boxes, stripping the comma / spaces automatically.
    ["#in-lat", "#in-lon"].forEach((sel) => {
      const input = $(sel);
      if (!input) return;
      input.addEventListener("paste", (e) => {
        const text = (e.clipboardData || window.clipboardData)?.getData("text") || "";
        const pair = splitLatLonPaste(text);
        if (!pair) return;
        e.preventDefault();
        $("#in-lat").value = pair.lat;
        $("#in-lon").value = pair.lon;
      });
    });
    $("#import-load").addEventListener("click", doImport);
    wireStepThree();
    wireAdvancedPanel();
    wireDropzone($("#site-dropzone"), $("#site-photo-input"), (files) => addSiteImages(files));
    // Map controls are built dynamically per slot in renderMapsSections() (each with
    // its own wired inputs), so there are no static map handlers to attach here.
    wireSiteDetails();
    $("#btn-clear-site").addEventListener("click", () => {
      $("#workspace").hidden = true;
      const wr = $("#workspace-right"); if (wr) wr.hidden = true;
      const ph = $("#report-placeholder"); if (ph) ph.hidden = false;
      renderRailNav(); // nothing to jump to with the workspace closed
      measureStatusBar(); // the collection bar went with it — release the pin offset
      showSitePicker();
    });
    $("#toggle-manual-internal").addEventListener("change", () => { renderDashboard(); renderCollectionStatus(); });
    const autoImgCb = $("#toggle-auto-images");
    if (autoImgCb) {
      autoImgCb.checked = autoImagesOn();
      autoImgCb.addEventListener("change", () => {
        setAutoImagesPref(autoImgCb.checked);
        toast(autoImgCb.checked ? "Auto-fetch reference images: on" : "Auto-fetch reference images: off");
      });
    }
    // The collection bar's segments are built per render (they carry live counts),
    // so their handlers ride on the buttons themselves — only the two fixed
    // controls are wired here.
    $("#cs-more").addEventListener("click", toggleStatusDetail);
    $("#cs-sort").addEventListener("click", () => setCardSort(state.cardSort === "attention" ? "source" : "attention"));
    try {
      const saved = localStorage.getItem(LS_CARD_SORT);
      if (saved === "attention" || saved === "source") state.cardSort = saved;
    } catch (_) {}
    syncSortToggle();
    // Mirror the two free-text header fields into `state` so state is the single
    // source of truth (saveNow / reportObject read state, not the DOM) — this lets
    // the batch flow persist and review sites whose DOM isn't currently shown.
    // Both fields are named on the report's document header too, so it repaints
    // with them — the deliverable's front page and step 2 always agree.
    $("#fld-date").addEventListener("change", () => { state.date = $("#fld-date").value; save(); renderSiteHeader(); renderReportHeader(); });
    $("#fld-maintenance").addEventListener("input", () => { state.maintenance = $("#fld-maintenance").value; save(); renderReportHeader(); });
    const rdocDetail = $("#btn-rdoc-detail");
    if (rdocDetail) rdocDetail.addEventListener("click", () => {
      const panel = $("#rdoc-detail");
      const open = panel.hidden;
      panel.hidden = !open;
      rdocDetail.setAttribute("aria-expanded", open ? "true" : "false");
      rdocDetail.textContent = open ? "Details ▴" : "Details ▾";
    });
    // Wrapped, not replaced: these are the buttons BOTH modes press (Focus's
    // finish step borrows this very menu), so the open-warning check belongs on
    // the handler rather than on either mode's copy of the control.
    $("#btn-print").addEventListener("click", guardExport(doPrint));
    $("#btn-download-html").addEventListener("click", guardExport(downloadHtml));
    $("#btn-download-json").addEventListener("click", guardExport(downloadJson));
    $("#btn-copy-summary").addEventListener("click", guardExport(copySummary));
    $("#btn-check-report").addEventListener("click", copyReviewPrompt);
    wireOverflowMenu();
    const batchReviewBtn = $("#btn-batch-review");
    if (batchReviewBtn) batchReviewBtn.addEventListener("click", copyBatchReviewPrompt);
    const batchClearBtn = $("#btn-batch-clear");
    if (batchClearBtn) batchClearBtn.addEventListener("click", () => {
      if (state.batch && confirm("Clear the batch list? Each site's saved work is kept — this only removes the batch grouping.")) clearBatch(false);
    });
    wireBatchBuilder();

    // The how-to guide: shown once as a welcome, then only on demand from the ?
    // in the collection header. "Got it" both closes it and settles the question
    // of whether this operator still needs it.
    const guideBtn = $("#btn-guide");
    if (guideBtn) guideBtn.addEventListener("click", () => {
      const open = $("#dash-guide") && !$("#dash-guide").hidden;
      setGuideOpen(!open);
    });
    const guideDone = $("#btn-guide-done");
    if (guideDone) guideDone.addEventListener("click", () => { markOnboarded(); setGuideOpen(false); });

    // pane focus (collapse one column, expand the other)
    for (const side of PANE_SIDES) {
      const btn = $(side.btn);
      if (btn) btn.addEventListener("click", () => setPaneMode(paneMode === side.mode ? "split" : side.mode));
    }
    let savedPane = null;
    try { savedPane = localStorage.getItem(LS_PANE); } catch (_) {}
    setPaneMode(savedPane || "split", false);
    // Linked scrolling — off unless this browser has been told otherwise.
    const syncBtn = $("#btn-pane-sync");
    if (syncBtn) syncBtn.addEventListener("click", () => setScrollSync(!scrollSync));
    let savedSync = null;
    try { savedSync = localStorage.getItem(LS_SYNC); } catch (_) {}
    setScrollSync(savedSync === "1", false);
    // The two panes teach each other by highlight rather than by 43 "find the
    // other half of this" buttons.
    wirePaneLinking();

    // narrow layout — the tab switcher that stands in for the pane handles below
    // 981px, plus the topbar's ⋯ popover.
    for (const t of M_TABS) {
      const btn = $(t.btn);
      if (btn) btn.addEventListener("click", () => setMobileTab(t.tab));
    }
    const mtabs = $("#mtabs");
    if (mtabs) mtabs.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
      e.preventDefault();
      const next = e.key === "Home" ? "collect"
        : e.key === "End" ? "report"
        : mTab === "collect" ? "report" : "collect";
      setMobileTab(next);
      const btn = $(M_TABS.find((t) => t.tab === next).btn);
      if (btn) btn.focus();
    });
    const moreBtn = $("#btn-topbar-more");
    if (moreBtn) moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setTopbarMenuOpen(!$("#topbar-meta").classList.contains("open"));
    });
    // Clicking one of the three actions is a decision — the popover has served its
    // purpose either way, so it closes on any click inside it or outside it.
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".topbar-meta-wrap") || e.target.closest(".topbar-meta")) setTopbarMenuOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !$("#topbar-meta").classList.contains("open")) return;
      setTopbarMenuOpen(false);
      if (moreBtn) moreBtn.focus();
    });
    syncNarrowRoles();
    if (window.matchMedia) {
      try { window.matchMedia(NARROW_MQ).addEventListener("change", syncNarrowRoles); } catch (_) {}
    }
    // agent.js opens its panel from the topbar; the panel is in the left column.
    const agentBtn = $("#btn-agent-settings");
    if (agentBtn) agentBtn.addEventListener("click", revealLeftPane);

    // The Focus ⇄ Workbench switch. Read the stored preference now so the button
    // is labelled correctly from the first paint, but leave applying it to init():
    // Focus mode's step list needs the source registry, and if the data load fails
    // the workbench is the right thing to be looking at (it is where the error
    // banner lives).
    uiMode = readUiMode();
    syncModeButton();
    const modeBtn = $("#btn-mode");
    if (modeBtn) modeBtn.addEventListener("click", () => setUiMode(focusLive() ? "workbench" : "focus"));
    wireFocusKeys();

    // theme switch + split-column sizing
    const themeBtn = $("#btn-theme");
    if (themeBtn) themeBtn.addEventListener("click", toggleTheme);
    syncThemeButton();
    if (window.matchMedia) {
      try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncThemeButton); } catch (_) {}
    }
    measureTopbar();
    measureStatusBar();
    measureReportHeader();
    measureMobileShell();
    window.addEventListener("resize", () => { measureTopbar(); measureStatusBar(); measureReportHeader(); measureMobileShell(); });
    // Keep the pinned collection bar's metrics honest: its height drives where the
    // group headers pin, and its position drives the pinned styling.
    const statusBar = $("#collection-status");
    if (statusBar && "ResizeObserver" in window) new ResizeObserver(measureStatusBar).observe(statusBar);
    // …and the report's document header, which drives where a jumped-to section lands.
    const docHead = $("#report .rdoc");
    if (docHead && "ResizeObserver" in window) new ResizeObserver(measureReportHeader).observe(docHead);
    // …and the narrow-layout shell, whose height does the same job below 981px.
    const shell = $("#mshell");
    if (shell && "ResizeObserver" in window) new ResizeObserver(measureMobileShell).observe(shell);
    const colLeft = $("#col-left");
    if (colLeft) {
      let queued = false;
      colLeft.addEventListener("scroll", () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; syncProgressPinned(); alignPanes("left"); });
      }, { passive: true });
    }
    const colRight = $("#col-right");
    if (colRight) {
      let queued = false;
      colRight.addEventListener("scroll", () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; alignPanes("right"); });
      }, { passive: true });
    }
  }

  // ---------------------------------------------------------------- init
  async function init() {
    wire();
    try {
      await loadData();
      await loadReference();
      await loadStatements();
      await loadStateBoundaries();
    } catch (err) {
      const local = location.protocol === "file:";
      showBanner("error",
        `<b>Could not load site data.</b> ${esc(err.message)}<br>` +
        (local
          ? `You've opened this file directly. Browsers block <code>fetch()</code> from <code>file://</code>. Serve the folder instead:<br><code>cd ess &amp;&amp; python3 -m http.server 8000</code> then open <code>http://localhost:8000/</code> — or publish via GitHub Pages.`
          : `Check that <code>data/stations.json</code>, <code>sources.json</code>, <code>dropdowns.json</code> and <code>meta.json</code> are present.`));
      // The banner lives in the left column, and there is no step list to build
      // without the source registry — so a failed load stays in the workbench.
      setUiMode("workbench", { persist: false });
      return;
    }
    $("#station-count-hint").textContent =
      `${DATA.stations.length.toLocaleString()} Bureau sites · ${DATA.sources.length} sources · data ${DATA.meta.generated_utc ? DATA.meta.generated_utc.slice(0, 10) : ""}`;
    $("#foot-meta").textContent = `${DATA.stations.length.toLocaleString()} sites · ${DATA.sources.length} sources.`;
    // Put the chosen view on screen BEFORE any site is restored, so a resumed
    // assessment renders once, into the mode it is going to be worked in.
    applyUiMode({ focus: false });
    restoreBatch(); // if a batch was loaded in a previous visit, show the tray + resume the active site
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
      web_search: fillTemplate(s.web_search || ""),
      is_ala: !!(s.api && s.api.kind === "ala_biocache"),
      is_wildnet: !!(s.api && s.api.kind === "wildnet"),
      no_result_means: s.no_result_means || "",
      // Public API a web-fetch-capable agent can query directly. ALA and WildNet are
      // excluded here because they each have their own dedicated client tool.
      api: (s.api && s.api.kind !== "ala_biocache" && s.api.kind !== "wildnet" && (s.api.base_url || s.api.openapi || s.api.endpoint || s.api.dataset))
        ? { base_url: s.api.base_url || "", openapi: s.api.openapi || "", endpoint: s.api.endpoint || "", dataset: s.api.dataset || "", docs: s.api.docs || "" }
        : null,
    })),
    setResult: (id, status, note, resultText, imageSubjects) => {
      if (!DATA.sources.find((x) => x.id === id) || !VALID_STATUS.has(status)) return false;
      const f = state.findings[id] || (state.findings[id] = {});
      f.status = status;
      if (note != null) f.note = String(note);
      if (resultText) f.result = { html: esc(String(resultText)).replace(/\n/g, "<br>"), ts: Date.now() };
      save(); refreshCard(id); renderCollectionStatus(); renderReport();
      maybeAutoFetchForSource(id, imageSubjects); // reference photos for species cards (Task 3)
      agentRunWrote++; // what endRun reports, and what tells a real run from one that fell over
      return true;
    },
    queryAla: (radius) => alaQuery(state.site.lat, state.site.lon, radius || 10),
    queryWildnet: (radius) => {
      const src = DATA.sources.find((x) => x.api && x.api.kind === "wildnet");
      return wildnetQuery(state.site.lat, state.site.lon, radius || (src && src.api && src.api.radius_km) || 10, src && src.api);
    },
    // Focus mode's derived step list, read-only. Exposed because it is a pure
    // function of state and the cheapest way to check the interleave is to log it
    // for a real site — re-route a card, re-log, and watch the step move.
    focusSteps: () => focusSteps().map((s) => ({ ...s })),
    beginRun: () => { agentRunWrote = 0; renderCollectionStatus(); },
    // An agent run fills the list itself and leaves the rest to a human, so when it
    // finishes the collection bar lands on that subset — see focusOnOutstanding.
    endRun: () => {
      focusOnOutstanding();
      // The run IS the automated round trip, done in one action rather than three,
      // so it records the same per-site receipts the three passes do — otherwise
      // the flow would go on asking for a prompt to be copied that nobody needs.
      // Only for a run that actually wrote something: endRun fires from agent.js's
      // `finally`, so a run that fell over on its first turn arrives here too.
      if (agentRunWrote) {
        markFlowDone("auto", "Claude ran the checks");
        markFlowDone("prompt", "Claude researched the sources itself");
        markFlowDone("applied", `${agentRunWrote} source${agentRunWrote === 1 ? "" : "s"} answered by Claude`);
      }
      save();
      // Focus resumes at the first step that still needs a human; the workbench
      // has no cursor to move, so it just repaints the list the run has changed.
      if (focusLive()) { focusAfterRun(agentRunWrote); return; }
      renderDashboard();
    },
  };

  document.addEventListener("DOMContentLoaded", init);
})();
