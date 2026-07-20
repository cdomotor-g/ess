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

  // Global preference: auto-source reference photos for the species/subjects
  // identified in a card's findings (from note edits, imports, and agent runs).
  // Persisted in localStorage; default on. Auto-fetch only ever *adds* images —
  // the user can delete any, and the manual "Fetch image" field always works.
  const LS_AUTO_IMAGES = "ess-workbench:v1:auto-images";
  // Batch membership (the list of sites imported together). Only the site keys +
  // display info live here; each site's full findings stay under its own per-site
  // key (siteKey), so a batch is just an index over storage that already exists.
  const LS_BATCH = "ess-workbench:v1:batch";
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
    date: "",
    maintenance: "",
    filterAttention: false, // dashboard: show only Manual/Failed/Not-checked
    filterStatus: null,     // dashboard: show only sources with this one status (found/none/failed/manual/unset)
    filterUnreviewed: false, // dashboard: show only sources not yet ticked "Reviewed"
    showAttention: false,   // show the attention banner (after import / agent run)
    batch: null,            // { generated, keys: [siteKey,…], active: siteKey|null } when a batch is loaded
  };
  const mapGenTokens = {}; // per-slot guard against a stale async render landing after a newer request
  const ATTENTION = ["manual", "failed", "unset"]; // statuses a human still owns
  const cardNumbers = {}; // sourceId -> position in the currently-rendered (filtered) dashboard list

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

  // ---------------------------------------------------------------- images
  // Station/evidence photos are downscaled client-side (canvas) before being kept
  // as JPEG data URLs — keeps localStorage + exported JSON/HTML a sane size while
  // staying fully self-contained (no server, no separate image files).
  const MAX_IMG_DIM = 1600, IMG_QUALITY = 0.82;
  let imgSeq = 0;
  const newImgId = () => `img${Date.now()}_${imgSeq++}`;

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
    saveImages(); renderSiteImages(); renderReport();
  }
  function removeSiteImage(id) {
    state.siteImages = state.siteImages.filter((im) => im.id !== id);
    saveImages(); renderSiteImages(); renderReport();
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
  function renderPhotoThumb(im, onRemove, onCaption) {
    // oninput saves as-you-type; onchange (fires on blur) refreshes the report
    // preview's figcaption — re-rendering on every keystroke would rebuild the
    // input out from under the user's cursor mid-edit.
    const cap = el("input", { type: "text", class: "photo-cap", placeholder: "Caption…",
      oninput: (e) => onCaption(e.target.value), onchange: () => renderReport() });
    cap.value = im.caption || "";
    return el("figure", { class: "photo-thumb" },
      el("img", { src: im.dataUrl, alt: im.caption || "Photo", loading: "lazy", decoding: "async",
        title: im.source_url ? "Open the source page" : "Click to view — zoom & pan", onclick: () => activateImage(im) }),
      el("button", { type: "button", class: "photo-remove", title: "Remove photo", onclick: onRemove }, "×"),
      cap,
      im.credit ? creditNode(im) : null);
  }
  // Report-preview thumbnail. onRemove (optional) adds a × to delete the photo
  // straight from the report; a Wikipedia photo opens its article, others zoom.
  function photoFigure(im, altFallback, onRemove) {
    const cap = im.caption || altFallback || "";
    return el("figure", { class: "photo-thumb view" },
      el("img", { src: im.dataUrl, alt: cap || "Photo", loading: "lazy", decoding: "async",
        title: im.source_url ? "Open the source page" : "Click to view — zoom & pan", onclick: () => activateImage(im) }),
      onRemove ? el("button", { type: "button", class: "photo-remove", title: "Remove this photo from the report", onclick: onRemove }, "×") : null,
      (cap || im.credit) ? el("figcaption", {}, cap, im.credit ? creditNode(im) : null) : null);
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
  function photosHtml(images, large) {
    if (!images || !images.length) return "";
    // esc() the data URL too, not just the caption — this string is injected via
    // innerHTML (print view) / a raw <script> template (HTML export), so an
    // unescaped value could break out of the src="" attribute (stored XSS) if it
    // ever originated from an imported findings file rather than our own canvas.
    return `<div class="pr-photos${large ? " pr-photos-large" : ""}">${images.map((im) => {
      const credit = im.credit
        ? `<span class="credit">${im.source_url ? `<a href="${esc(im.source_url)}">${esc(im.credit)}</a>` : esc(im.credit)}</span>` : "";
      const cap = (im.caption || im.credit)
        ? `<figcaption>${esc(im.caption || "")}${credit}</figcaption>` : "";
      return `<figure><img src="${esc(im.data_url)}" alt="${esc(im.caption || "")}">${cap}</figure>`;
    }).join("")}</div>`;
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
      source_url: safeHttpUrl(im && (im.source_url || im.sourceUrl)), ts: Date.now(),
    })).filter((im) => DATA_IMG_RE.test(im.dataUrl));
  }

  function renderSiteImages() {
    const grid = $("#site-photo-grid");
    if (!grid) return;
    grid.innerHTML = "";
    (state.siteImages || []).forEach((im) => grid.append(renderPhotoThumb(im, () => removeSiteImage(im.id), (v) => { im.caption = v; saveImages(); })));
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
    state.date = new Date().toISOString().slice(0, 10);
    state.maintenance = "";
    state.filterAttention = false;
    state.filterStatus = null;
    state.filterUnreviewed = false;
    state.showAttention = false;
    imagesDirty = false; // fresh state; restore() re-flags this if a legacy save needs migrating
    restore(); // pull any saved progress for this site
  }

  function loadSite(site) {
    flushSave(); // persist any pending debounced edit for the previous site before switching
    loadSiteState(site);
    syncBatchActive(); // highlight the matching chip if this site belongs to the loaded batch
    renderWorkspace();
  }

  function renderWorkspace() {
    $("#workspace").hidden = false;
    const wr = $("#workspace-right"); if (wr) wr.hidden = false;
    const ph = $("#report-placeholder"); if (ph) ph.hidden = true;
    measureTopbar();
    renderSummary();
    renderSiteImages();
    renderMapsSections();
    ensureAllMaps();
    renderDashboard();
    renderReport();
    renderProgress();
    syncFilterButton();
    $("#fld-date").value = state.date;
    $("#fld-maintenance").value = state.maintenance;
    $("#workspace").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function isFindingsObject(json) {
    return json && typeof json === "object" && json.site && Array.isArray(json.collection_log);
  }

  // Build `state` from one ess-findings/1 object, WITHOUT rendering, saving, or
  // fetching images. The reusable core of importFindings — the batch importer calls
  // it once per site to populate + persist each without a full workspace render.
  function applyFindings(json) {
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
    state.report = {};
    (json.sections || []).forEach((s) => { if (s && s.id) state.report[s.id] = { choice: s.choice || null, note: s.note || "", reviewed: !!s.reviewed }; });
    // Seed jurisdiction-specific section defaults (e.g. the QLD GBO text) where the
    // imported file left the section blank, so they still appear in the report.
    REPORT_SECTIONS.forEach((sec) => {
      const def = defaultSectionNote(sec.id);
      if (!def) return;
      const rs = state.report[sec.id] || (state.report[sec.id] = { choice: null, note: "" });
      if (!rs.note || !rs.note.trim()) rs.note = def;
    });
    state.date = si.assessment_date || new Date().toISOString().slice(0, 10);
    state.maintenance = si.site_maintenance || "";
    state.filterAttention = false;
    state.filterStatus = null;
    state.filterUnreviewed = false;
    state.showAttention = true; // surface what the agent left for the human
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
    toast(`Batch of ${keys.length} site${keys.length > 1 ? "s" : ""} ready — pick one below to start`);
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
      saveImages(); renderSiteMap(slot); renderReport();
    } catch (err) {
      if (token !== mapGenTokens[slot] || state.site !== site) return;
      ms.status = "error"; ms.error = err.message || "could not load the map";
      renderSiteMap(slot);
    }
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
      save(); refreshCard(sourceId); renderProgress(); renderReport();
      toast(res.found
        ? `PMST imported — MNES summary added${seeded ? `, and ${seeded} section narrative${seeded > 1 ? "s" : ""} drafted` : ""}.`
        : "PMST imported — no MNES matters returned.");
    } catch (err) {
      if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = orig; }
      toast(err.message || "Could not read that .xlsx file.");
    }
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
    if (state.filterStatus)
      list = list.filter((s) => ((state.findings[s.id] || {}).status || "unset") === state.filterStatus);
    else if (state.filterAttention)
      list = list.filter((s) => ATTENTION.includes((state.findings[s.id] || {}).status || "unset"));
    if (state.filterUnreviewed)
      list = list.filter((s) => !(state.findings[s.id] || {}).reviewed);
    for (const id of Object.keys(cardNumbers)) delete cardNumbers[id];
    let n = 0;
    for (const cat of cats) {
      const inCat = list.filter((s) => s.category === cat.id).sort((a, b) => (a.priority || 99) - (b.priority || 99));
      if (!inCat.length) continue;
      const group = el("div", { class: "group" });
      group.append(el("div", { class: "group-head" },
        el("h3", {}, cat.label),
        el("span", { class: "g-count" }, `${inCat.length}`),
        el("span", { class: "g-line" })));
      inCat.forEach((src) => { cardNumbers[src.id] = ++n; group.append(renderSourceCard(src)); });
      wrap.append(group);
    }
    if (!wrap.children.length)
      wrap.append(el("p", { class: "dash-note", style: "margin:8px 0" },
        state.filterStatus ? `No sources marked "${STATUS_LABEL[state.filterStatus]}".` :
        state.filterAttention ? "✓ Nothing needs attention — every source has a result." :
        state.filterUnreviewed ? "✓ Everything has been reviewed." : "No sources for this site."));
    syncStatusFilterBar();
    syncUnreviewedFilterButton();
  }

  function renderSourceCard(src) {
    const f = state.findings[src.id] || (state.findings[src.id] = { status: STATUS.UNSET, note: "", result: null, images: [], reviewed: false });
    if (!f.images) f.images = [];
    const card = el("div", { class: `src status-${f.status}${f.reviewed ? " is-reviewed" : ""}`, id: `src-${src.id}` });
    const num = cardNumbers[src.id];

    // "checked" is a boolean HTML attribute — setAttribute("checked", false) would
    // still mark it checked, so set the property directly instead of via el(attrs).
    const reviewCbInput = el("input", { type: "checkbox", onchange: (e) => setReviewed(src.id, e.target.checked) });
    reviewCbInput.checked = !!f.reviewed;
    const reviewToggle = el("label", { class: "review-toggle" + (f.reviewed ? " on" : ""), title: "Tick once you're satisfied with this source's result" },
      reviewCbInput,
      el("span", {}, f.reviewed ? "✓ Reviewed" : "Mark reviewed"));

    const tags = [];
    if (src.method === "api") tags.push(el("span", { class: "tag api" }, "API"));
    if (src.internal) tags.push(el("span", { class: "tag internal" }, "Internal"));
    tags.push(el("span", { class: "tag jur" }, src.jurisdiction === "national" ? "National" : (state.site.state || "State")));

    const link = el("a", {
      href: buildUrl(src), target: "_blank", rel: "noopener", class: "btn tiny",
      title: buildUrl(src),
      onclick: () => copy(`${state.site.lat}, ${state.site.lon}`, "Coordinates copied"),
    }, "Open ↗");

    // Copy just the site's lat/long — for when the operator already has the tab
    // the "Open ↗" link would open and only needs to paste the coordinates in.
    const copyCoordBtn = el("button", {
      type: "button", class: "btn tiny",
      title: "Copy this site's latitude, longitude to the clipboard",
      onclick: () => copy(`${state.site.lat}, ${state.site.lon}`, "Lat/Lon copied"),
    }, "⧉ Copy Lat Lon");

    const statusSel = el("div", { class: "status-select" });
    [[STATUS.FOUND, "Found"], [STATUS.NONE, "None"], [STATUS.FAILED, "Failed"], [STATUS.MANUAL, "Manual"]].forEach(([s, lab]) => {
      statusSel.append(el("button", {
        "data-s": s, class: f.status === s ? "on" : "",
        onclick: () => setStatus(src.id, s),
      }, lab));
    });

    const actions = el("div", { class: "src-actions" }, link, copyCoordBtn, statusSel);
    const runner = apiRunnerFor(src);
    if (runner) {
      actions.append(el("button", { class: "btn tiny primary", id: `run-${src.id}`, onclick: () => runner(src) }, "Check live"));
    }
    // PMST card: upload the tool's Excel export and extract the MNES summary in-browser.
    if (src.xlsx_import === "pmst_mnes") {
      const fileInput = el("input", {
        type: "file", accept: ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", hidden: true,
        onchange: (e) => { const file = e.target.files && e.target.files[0]; if (file) importPmstXlsx(src.id, file, importBtn); e.target.value = ""; },
      });
      const importBtn = el("button", {
        type: "button", class: "btn tiny primary",
        title: "Upload the PMST Excel export — extracts the Matters of National Environmental Significance (Known-only for species & communities) into the notes below",
        onclick: () => fileInput.click(),
      }, "⬆ Import PMST Excel");
      actions.append(importBtn, fileInput);
    }
    if (src.web_search) {
      const q = encodeURIComponent(fillTemplate(src.web_search));
      actions.append(el("a", { href: `https://www.google.com/search?q=${q}`, target: "_blank", rel: "noopener", class: "btn tiny" }, "Web search ↗"));
    }

    // onchange fires on blur; re-render the report so the edited note lands in its
    // target section live (the report is a separate DOM tree, so rebuilding it never
    // disturbs a click on this card). Editing the notes NO LONGER triggers any
    // automatic Wikipedia image search in the background — that turned every note
    // edit into a burst of network fetches + canvas work that bogged the browser
    // down. Reference photos are now pulled only on explicit request (the "✨
    // Reference image from notes" / "🔎 Search by name…" buttons on the card).
    const note = el("textarea", {
      placeholder: "Notes / evidence for the report…",
      oninput: (e) => { f.note = e.target.value; save(); },
      onchange: () => { renderReport(); },
    });
    note.value = f.note || "";
    // Wipe just the notes text (keeps photos/reference images) so an operator can
    // clear agentic entries and redo a card's notes from scratch.
    const clearNoteBtn = el("button", { type: "button", class: "btn tiny note-clear",
      title: "Clear the notes text for this card (photos are kept)",
      onclick: () => clearNote(src.id, note) }, "Clear");

    let photoBlock = null;
    if (PHOTO_CATEGORIES.has(src.category)) {
      const input = el("input", { type: "file", accept: "image/*", multiple: true, hidden: true });
      const pickBtn = el("button", { type: "button", class: "pick-btn" }, "choose a file");
      const zone = el("div", { class: "dropzone small", tabindex: "0", "aria-label": "Add evidence photo — paste, drag and drop, or choose a file" },
        "📷 Evidence photo — drag & drop, paste, or ", pickBtn);
      wireDropzone(zone, input, (files) => addFindingImages(src.id, files));
      const grid = el("div", { class: "photo-grid small" });
      f.images.forEach((im) => grid.append(renderPhotoThumb(im, () => removeFindingImage(src.id, im.id), (v) => { im.caption = v; saveImages(); })));
      const wikiRow = WIKI_IMAGE_CATEGORIES.has(src.category) ? renderWikiImageRow(src) : null;
      photoBlock = el("div", { class: "src-photos" }, zone, wikiRow, input, grid);
    }

    // card.append() is the native DOM method (not the el() helper), which stringifies
    // a null argument to the literal text "null" instead of skipping it — filter first.
    card.append(...[
      el("div", { class: "src-top" },
        el("div", { class: "src-name" }, el("span", { class: "src-num" }, num ? `${num}` : ""), src.name, ...tags),
        el("div", { class: "src-top-right" },
          reviewToggle,
          el("span", { class: "chip " + (f.status === "unset" ? "manual" : f.status), style: f.status === "unset" ? "opacity:.5" : "" }, STATUS_LABEL[f.status]))),
      el("div", { class: "src-desc" }, src.what_to_find || ""),
      actions,
      el("div", { class: "src-note" },
        el("div", { class: "note-head" }, el("label", { class: "note-label" }, "Notes & evidence"), clearNoteBtn),
        note),
      photoBlock,
      renderIncludeRow(src),
      el("div", { class: "src-result" + (f.result ? " show" : ""), id: `res-${src.id}`, html: f.result ? f.result.html : "" }),
    ].filter(Boolean));
    return card;
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
    const fetchBtn = el("button", { type: "button", class: "btn tiny", onclick: () => fetchWikiImage(src.id, inp, fetchBtn) }, "🔎 Fetch");
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); fetchWikiImage(src.id, inp, fetchBtn); } });
    const searchRow = el("div", { class: "wiki-row collapsed" },
      el("span", { class: "wiki-lead" }, "🌐 From Wikipedia:"), inp, fetchBtn);
    if (useList) {
      const dl = el("datalist", { id: listId });
      DATA.weeds.forEach((w) => dl.append(el("option", { value: w })));
      searchRow.append(dl);
    }
    // Auto-fetch: scan this card's notes for species/subjects and fetch a photo for
    // each (also runs on note blur when the global "Auto-fetch" preference is on).
    const autoBtn = el("button", { type: "button", class: "btn tiny",
      title: "Scan this card's notes and fetch a labelled Wikipedia photo for every species/subject detected",
      onclick: () => autoFetchFromNotes(src.id, autoBtn) }, "✨ Reference image from notes");
    // Reveal the manual search field on demand — keeps the resting card uncluttered.
    const searchToggle = el("button", { type: "button", class: "btn tiny",
      title: "Search Wikipedia for a reference image by typing a species/subject name",
      onclick: () => { const collapsed = searchRow.classList.toggle("collapsed"); if (!collapsed) inp.focus(); } }, "🔎 Search by name…");
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
    renderProgress();
    renderReport(); // evidence + suggested choices may change
  }

  // Tracks the operator's own "I've reviewed this card" progress — independent
  // of the Found/None/Failed/Manual result, which is about the source, not the human.
  function setReviewed(id, reviewed) {
    const f = state.findings[id] || (state.findings[id] = { status: STATUS.UNSET, note: "", result: null, images: [] });
    f.reviewed = !!reviewed;
    save();
    if (state.filterUnreviewed && f.reviewed) renderDashboard(); // ticking removes it from this filter
    else refreshCard(id);
    renderProgress();
  }

  function refreshCard(id) {
    const src = DATA.sources.find((s) => s.id === id);
    const old = $(`#src-${id}`);
    if (old && src) old.replaceWith(renderSourceCard(src));
  }

  // Clear the notes text for a card (photos + reference images are kept). Handy for
  // wiping agentic entries and redoing a card's notes from scratch. Confirmed
  // because there's no undo and the text may be substantial.
  function clearNote(id, textarea) {
    const f = state.findings[id];
    if (!f || !(f.note && f.note.trim())) { toast("No notes to clear on this card."); return; }
    if (!confirm("Clear the Notes & Evidence text for this card?\n\nPhotos and reference images are kept. This can't be undone.")) return;
    f.note = "";
    if (textarea) textarea.value = "";
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
      maybeAutoFetchForSource(src.id); // reference photos for any listed taxa (Task 3)
    } catch (err) {
      const f = state.findings[src.id] || (state.findings[src.id] = {});
      f.status = STATUS.FAILED;
      f.result = { html: `Could not reach the Atlas of Living Australia API (${esc(err.message)}). This is usually a network or browser CORS restriction. Use the <b>Open ↗</b> link to check manually, then set the result.`, err: true, ts: Date.now() };
      save(); refreshCard(src.id);
      const r = $(`#res-${src.id}`); if (r) r.classList.add("err");
      renderProgress(); renderReport();
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
    btn.disabled = true; btn.innerHTML = `<span class="spin"></span> Checking…`;
    res.className = "src-result show"; res.innerHTML = "Querying Queensland WildNet…";
    try {
      const r = await wildnetQuery(s.lat, s.lon, radius, src.api);
      const f = state.findings[src.id] || (state.findings[src.id] = {});
      f.status = r.status; f.result = { html: r.html, ts: Date.now() };
      save(); refreshCard(src.id); renderProgress(); renderReport();
      maybeAutoFetchForSource(src.id);
    } catch (err) {
      const f = state.findings[src.id] || (state.findings[src.id] = {});
      f.status = STATUS.FAILED;
      f.result = { html: `Could not reach the Queensland WildNet API (${esc(err.message)}). This is usually a network or browser CORS restriction. Use the <b>Open ↗</b> link to run the search in the WildNet app, then set the result.`, err: true, ts: Date.now() };
      save(); refreshCard(src.id);
      const rr = $(`#res-${src.id}`); if (rr) rr.classList.add("err");
      renderProgress(); renderReport();
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

  async function runAllAuto() {
    for (const src of sourcesForSite()) {
      const runner = apiRunnerFor(src);
      if (runner) await runner(src);
    }
  }

  // ---------------------------------------------------------------- progress
  function renderProgress() {
    const list = sourcesForSite();
    const counts = { found: 0, none: 0, failed: 0, manual: 0, unset: 0 };
    let reviewed = 0;
    list.forEach((s) => {
      const f = state.findings[s.id] || {};
      counts[f.status || "unset"]++;
      if (f.reviewed) reviewed++;
    });
    const done = list.length - counts.unset;
    $("#progress-bar").style.width = list.length ? `${Math.round((done / list.length) * 100)}%` : "0";
    $("#progress-legend").innerHTML =
      `<span><b>${done}</b>/${list.length} checked</span>` +
      `<span class="chip found">${counts.found} found</span>` +
      `<span class="chip none">${counts.none} none</span>` +
      `<span class="chip failed">${counts.failed} failed</span>` +
      `<span class="chip manual">${counts.manual} manual</span>` +
      `<span class="chip reviewed">${reviewed}/${list.length} reviewed</span>`;
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
      onclick: () => {
        state.filterAttention = !state.filterAttention;
        if (state.filterAttention) state.filterStatus = null;
        renderDashboard(); renderAttention(); syncFilterButton();
      },
    }, state.filterAttention ? "Show all" : "Show only these"));
    actions.append(el("button", { class: "btn tiny", onclick: () => { state.showAttention = false; renderAttention(); } }, "Dismiss"));
    b.append(msg, actions);
  }

  function syncFilterButton() {
    const btn = $("#btn-filter-attention");
    if (btn) btn.classList.toggle("on", state.filterAttention);
  }

  function syncUnreviewedFilterButton() {
    const btn = $("#btn-filter-unreviewed");
    if (btn) btn.classList.toggle("on", state.filterUnreviewed);
  }

  function syncStatusFilterBar() {
    $$(".sfb-btn").forEach((btn) => btn.classList.toggle("on", btn.dataset.status === state.filterStatus));
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
  function toggleInclude(id) {
    const f = state.findings[id] || (state.findings[id] = { status: STATUS.UNSET, note: "", result: null, images: [] });
    f.included = !cardIncluded(f);
    save(); refreshCard(id); renderReport();
  }

  // -------------------------------------------------- cross-column "Show" jumps
  // The two columns scroll independently (desktop) or the page scrolls (narrow),
  // so scrollIntoView() targets the right scroll container automatically. A brief
  // highlight helps the eye land on whatever was jumped to.
  function flashTarget(node) {
    if (!node) return;
    node.classList.remove("flash-target");
    void node.offsetWidth; // restart the animation if it's still running
    node.classList.add("flash-target");
    setTimeout(() => node.classList.remove("flash-target"), 1500);
  }
  // Left card's "Show" → scroll the report (right) to this card's target section.
  function showReportSection(sectionId) {
    const node = document.getElementById(`rsec-${sectionId}`);
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "start" });
    flashTarget(node);
  }
  // Report block's "Show" → scroll the collection (left) to the source card. The
  // card may be hidden by an active dashboard filter, so clear filters and
  // re-render first if it isn't currently on screen.
  function showSourceCard(sourceId) {
    let node = document.getElementById(`src-${sourceId}`);
    if (!node) {
      state.filterStatus = null;
      state.filterAttention = false;
      state.filterUnreviewed = false;
      const internalToggle = $("#toggle-manual-internal");
      if (internalToggle && !internalToggle.checked) internalToggle.checked = true;
      renderDashboard();
      syncFilterButton();
      node = document.getElementById(`src-${sourceId}`);
    }
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "start" });
    flashTarget(node);
  }

  // The Include control shown on each source card: a target-section dropdown + a
  // toggle button. Editing the card's notes/photos afterwards updates the report
  // live (the report re-renders from state), so multiple sources can land in one
  // section and stay in sync without any copy/paste going stale.
  function renderIncludeRow(src) {
    const f = state.findings[src.id] || (state.findings[src.id] = { status: STATUS.UNSET, note: "", result: null, images: [] });
    // Internal / login-only sources are operator working items only — their notes
    // are staff instructions ("check internal system X"), never ESS report content,
    // so they can't be added to a report section and get an explainer instead of
    // the Include controls.
    if (src.internal) {
      return el("div", { class: "include-row is-internal" },
        el("span", { class: "inc-lead" }, "🔒 Internal check"),
        el("span", { class: "inc-internal-note" }, "For the operator only — kept out of the ESS report. Record it here so it's actioned before the site visit."));
    }
    const included = cardIncluded(f);
    const target = targetSectionOf(src, f);
    const sel = el("select", { class: "inc-target",
      title: "Which ESS report section this card's notes & photos appear in",
      onchange: (e) => setTargetSection(src.id, e.target.value) });
    REPORT_SECTIONS.forEach((s) => sel.append(el("option", { value: s.id, selected: s.id === target ? "selected" : null }, s.title)));
    const btn = el("button", { type: "button", class: "btn tiny inc-btn" + (included ? " on" : ""),
      title: included ? "Currently included — click to remove from the report" : "Add this card's notes & photos to the report section",
      onclick: () => toggleInclude(src.id) }, included ? "✓ In report" : "＋ Include");
    const showBtn = el("button", { type: "button", class: "btn tiny inc-show",
      title: "Scroll the report (right) to this card's target section",
      onclick: () => showReportSection(targetSectionOf(src)) }, "Show ⇢");
    return el("div", { class: "include-row" + (included ? " is-in" : "") },
      el("span", { class: "inc-lead" }, "Add to report:"), sel, btn, showBtn);
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
  // plus the standardized templates — the "✨ Insert suggested detail" button.
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

  // Flag the mistakes the human sheets are full of: a standardized statement that
  // contradicts the section's evidence, or a "matters present" statement left with
  // no supporting detail. Only applies to the none/known-scale dropdowns (their
  // first option starts "There are no…"); skips the biosecurity treatment scale.
  function sectionWarnings(section, rstate) {
    if (!section || !section.dropdown) return [];
    const opts = DATA.dropdowns[section.dropdown] || [];
    if (!opts.length || !/^there are no/i.test(opts[0])) return [];
    const idx = opts.indexOf(rstate.choice || "");
    if (idx < 0) return [];
    const ev = includedCardsForSection(section.id);
    const anyFound = ev.some((x) => x.f.status === "found");
    const note = rstate.note || "";
    const noteHasMatter = /\b(critically|endangered|vulnerable|threatened|listed|weed|weeds|pest|pests|declared|heritage|ramsar|world heritage)\b/i.test(note);
    const w = [];
    if (idx === 0 && (anyFound || noteHasMatter))
      w.push('Statement says "no known…" but the evidence or notes indicate matters were found — reconsider the statement or the note.');
    if (idx >= 1 && !anyFound && !note.trim())
      w.push("Statement indicates matters are present, but no supporting detail is recorded — add the specifics.");
    return w;
  }

  function renderReport() {
    const wrap = $("#report-sections");
    wrap.innerHTML = "";
    // Both locator maps, side by side, square + equally sized (see .report-maps CSS).
    const readyMaps = state.site ? MAP_SLOTS.filter((slot) => { const ms = state.maps[slot.key]; return ms && ms.image && ms.image.dataUrl; }) : [];
    if (readyMaps.length) {
      const box = el("div", { class: "rsection" }, el("h3", {}, readyMaps.length > 1 ? "Location maps" : "Location map"));
      // Grid columns follow the number of ready maps, so a single (still-loading or
      // failed) slot fills the width instead of leaving an empty half.
      const row = el("div", { class: "report-maps", style: `grid-template-columns:repeat(${readyMaps.length},1fr)` });
      readyMaps.forEach((slot) => {
        const m = state.maps[slot.key].image;
        row.append(el("figure", { class: "report-map" },
          el("img", { src: m.dataUrl, alt: `${slot.title} — satellite locator`, loading: "lazy", decoding: "async",
            title: "Open the full-screen map — scroll to zoom, drag to pan",
            onclick: () => openLightbox(m.dataUrl, `${slot.title} — ${(+m.km).toLocaleString()} km across · ${state.site.name}`) }),
          el("figcaption", {}, `${slot.title} — ${(+m.km).toLocaleString()} km across · centred on ${state.site.lat}, ${state.site.lon} · ${MAP_ATTRIB}${m.labels ? " · " + MAP_REF_ATTRIB : ""}`)));
      });
      box.append(row);
      wrap.append(box);
    }
    if ((state.siteImages || []).length) {
      const box = el("div", { class: "rsection" }, el("h3", {}, "Site photographs"));
      const grid = el("div", { class: "photo-grid report-large" });
      state.siteImages.forEach((im) => grid.append(photoFigure(im, "", () => removeSiteImage(im.id))));
      box.append(grid);
      wrap.append(box);
    }
    REPORT_SECTIONS.forEach((section) => {
      const rstate = state.report[section.id] || (state.report[section.id] = newReportState(section.id));
      if (rstate.choice == null && section.dropdown) rstate.choice = suggestChoice(section);

      const box = el("div", { class: "rsection" + (rstate.reviewed ? " is-reviewed" : ""), id: `rsec-${section.id}` });
      // Per-section "Reviewed" tickbox — lets the operator track progress through the
      // report the same way the collection cards do. Updated in place (no full report
      // re-render) so ticking stays cheap on image-heavy sites.
      const revInput = el("input", { type: "checkbox" });
      revInput.checked = !!rstate.reviewed;
      const revToggle = el("label", { class: "review-toggle" + (rstate.reviewed ? " on" : ""),
        title: "Tick once you've reviewed this report section" },
        revInput, el("span", {}, rstate.reviewed ? "✓ Reviewed" : "Mark reviewed"));
      revInput.addEventListener("change", (e) => setSectionReviewed(section.id, e.target.checked, box, revToggle));
      box.append(el("div", { class: "rsec-head" }, el("h3", {}, section.title), revToggle));

      if (section.dropdown) {
        const opts = DATA.dropdowns[section.dropdown] || [];
        const sel = el("select", { onchange: (e) => { rstate.choice = e.target.value; save(); renderReportWarnings(section, box, rstate); if (section.bioDetail) syncBioDetail(section, box); } });
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

      const ta = el("textarea", { placeholder: "Free-text comments for this section…", oninput: (e) => { rstate.note = e.target.value; renderReportWarnings(section, box, rstate); save(); } });
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
            rstate.note = ta.value; renderReportWarnings(section, box, rstate); save();
          } }, "✨ Insert suggested detail");
        box.append(el("div", { class: "r-actions" }, btn));
      }

      // Included sources: each card the operator added to THIS section contributes
      // its status, notes and photos — grouped by source, de-duplicated, and every
      // photo individually removable. Editing the card updates this live.
      const inc = includedCardsForSection(section.id);
      if (inc.length) {
        const incWrap = el("div", { class: "r-included" });
        const seenImg = new Set();
        inc.forEach(({ src, f }) => {
          const st = f.status && f.status !== "unset" ? f.status : "unset";
          // Same number this source carries on its collection card (left pane) so the
          // two columns can be cross-referenced at a glance. On-screen aid only — the
          // number is NOT part of reportObject()/buildReportHtml, so it never reaches
          // the exported/printed report.
          const num = cardNumbers[src.id];
          const head = el("div", { class: "r-inc-head" },
            num ? el("span", { class: "src-num", title: "Collection card number (left pane)" }, `${num}`) : null,
            el("span", { class: "chip " + (st === "unset" ? "manual" : st), style: st === "unset" ? "opacity:.5" : "" }, STATUS_LABEL[st]),
            el("span", { class: "r-inc-name" }, src.name),
            el("div", { class: "r-inc-actions" },
              el("button", { type: "button", class: "btn tiny r-inc-show", title: "Scroll the collection (left) to this source's card", onclick: () => showSourceCard(src.id) }, "⇠ Show"),
              el("button", { type: "button", class: "btn tiny r-inc-remove", title: "Remove this source from the report section", onclick: () => toggleInclude(src.id) }, "Remove")));
          const item = el("div", { class: "r-inc-item status-" + st }, head);
          if (f.note && f.note.trim()) item.append(el("div", { class: "r-inc-note" }, f.note.trim()));
          const imgs = (f.images || []).filter((im) => { const k = im.dataUrl || im.id; if (seenImg.has(k)) return false; seenImg.add(k); return true; });
          if (imgs.length) {
            const grid = el("div", { class: "photo-grid small" });
            imgs.forEach((im) => grid.append(photoFigure(im, src.name, () => removeFindingImage(src.id, im.id))));
            item.append(grid);
          }
          if ((!f.note || !f.note.trim()) && !imgs.length)
            item.append(el("div", { class: "r-inc-empty" }, "Included — add notes or photos on the source card."));
          incWrap.append(item);
        });
        box.append(incWrap);
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

  // Repaint just this section's consistency warnings (called live as the note or
  // the dropdown changes, without re-rendering the whole report).
  function renderReportWarnings(section, box, rstate) {
    const holder = box.querySelector(".r-warns");
    if (!holder) return;
    holder.innerHTML = "";
    sectionWarnings(section, rstate).forEach((msg) =>
      holder.append(el("p", { class: "r-warn" }, "⚠ ", msg)));
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
      if (span) span.textContent = rstate.reviewed ? "✓ Reviewed" : "Mark reviewed";
    }
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
      date: state.date,
      maintenance: state.maintenance,
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
      const hasAny = state.siteImages.length || Object.keys(mapImages).length || Object.keys(findingImages).length;
      try {
        if (hasAny)
          localStorage.setItem(key + IMG_SUFFIX, JSON.stringify({ siteImages: state.siteImages, mapImages, findingImages }));
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
      state.date = d.date || state.date;
      state.maintenance = d.maintenance || "";
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
    };
  }

  function buildReportHtml(forPrint) {
    const r = reportObject();
    const s = r.site;
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
      ? `<div class="pr-sec"><h2>Site photographs</h2>${photosHtml(s.images, true)}</div>` : "";
    const nl2br = (x) => esc(x).replace(/\n/g, "<br>");
    const evNotesHtml = (sec) => (sec.evidence_notes && sec.evidence_notes.length)
      ? `<div class="pr-ev">${sec.evidence_notes.map((e) =>
          `<p class="pr-ev-item"><span class="st st-${esc(e.status)}">${esc(STATUS_LABEL[e.status] || e.status)}</span> <b>${esc(e.source)}</b> — ${esc(e.note)}</p>`).join("")}</div>`
      : "";
    const secRows = r.sections.map((sec) => `<div class="pr-sec"><h2>${esc(sec.title)}</h2>
      ${sec.choice ? `<p><b>${esc(sec.choice)}</b></p>` : ""}
      ${sec.detail ? `<p>${nl2br(sec.detail)}</p>` : ""}
      ${sec.note ? `<p>${nl2br(sec.note)}</p>` : ""}
      ${(sec.warnings || []).map((wn) => `<p class="pr-warn">⚠ Review: ${esc(wn)}</p>`).join("")}
      ${evNotesHtml(sec)}
      ${photosHtml(sec.images)}</div>`).join("");
    // Internal / login-only sources are operator working items — keep their
    // "check internal system X" instructions out of the exported report entirely.
    const logRows = r.collection_log.filter((c) => !c.internal).map((c) => `<tr>
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
      ${mapBlock}
      ${siteShots}
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
      .k{color:#555} .st{font-weight:700} .st-found{color:#c1123c}.st-none{color:#8a6d1a}.st-failed{color:#b3261e}.st-manual{color:#3a5a99}
      .pr-photos{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px} .pr-photos figure{margin:0;width:150px}
      .pr-photos img{width:100%;height:110px;object-fit:cover;border:1px solid #bbb;border-radius:4px}
      .pr-photos figcaption{font-size:10px;color:#444;margin-top:2px}
      .pr-photos figcaption .credit{display:block;font-size:9px;color:#777;margin-top:1px}
      .pr-photos figcaption .credit a{color:#777}
      .pr-photos.pr-photos-large{gap:12px} .pr-photos.pr-photos-large figure{width:300px}
      .pr-photos.pr-photos-large img{height:auto;max-height:340px;object-fit:contain}
      .pr-ev{margin:6px 0 0} .pr-ev-item{font-size:11.5px;color:#333;margin:3px 0}
      .pr-maps{display:flex;gap:12px;align-items:flex-start}
      .pr-map-fig{margin:0;flex:1 1 0;min-width:0}
      .pr-map-img{display:block;width:100%;aspect-ratio:1/1;object-fit:cover;border:1px solid #bbb;border-radius:6px}
      .pr-map-cap{font-size:10px;color:#444;margin:4px 0 0}
      .pr-warn{font-size:11px;font-weight:600;color:#b3261e;background:#fbe6e4;border-radius:5px;padding:5px 8px;margin:6px 0 0}</style>
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
  // Build a complete, self-contained, model-agnostic prompt for the current
  // site. It embeds every step, every applicable source aimed at the location,
  // the standardized report wording, and a ready-to-fill ess-findings/1
  // skeleton — so a user can paste it into ANY LLM/assistant, do the research
  // externally, and hand the JSON straight back into "Import agent findings".
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
    L.push(`Fill in the JSON object below and return **only** that object — no commentary, no markdown fences — so it can be pasted directly into the tool at "Choose a site → Import agent findings".`);
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
    copy(buildFullPrompt());
    flashButton((e && e.currentTarget) || $("#btn-copy-prompt"));
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

  function countStatuses(d) {
    const f = (d && d.findings) || {};
    let found = 0, attention = 0, total = 0;
    for (const v of Object.values(f)) {
      total++;
      if (v.status === "found") found++;
      if (!v.status || v.status === "manual" || v.status === "failed" || v.status === STATUS.UNSET) attention++;
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
      if (c.attention) meta.append(el("span", { class: "bc attn", title: `${c.attention} need attention` }, `⚠ ${c.attention}`));
      if (!c.found && !c.attention && c.total) meta.append(el("span", { class: "bc ok", title: "all reviewed / nothing outstanding" }, "✓"));
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
    if (site) loadSite(site); // resume where the user left off
  }

  // -------------------------------------------------- batch builder (modal)
  // In-browser multi-site picker: search + add stations (or paste a list), then
  // "Start batch" hands the collected site objects to createBatchFromSites.
  let bbSel = [];          // selected site objects, in add order
  let bbAcMatches = [], bbAcIndex = -1;

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
    setTimeout(() => $("#bb-search").focus(), 0);
  }
  function closeBatchBuilder() {
    const ov = $("#batch-builder");
    if (!ov) return;
    ov.classList.remove("show");
    ov.hidden = true;
    $("#bb-results").hidden = true;
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

  // The report toolbar's "More ▾" overflow menu (Print / JSON / Copy summary).
  // Keeps the toolbar uncluttered now that Generate Report + Check report lead.
  function wireOverflowMenu() {
    const menu = $("#report-more-menu");
    if (!menu) return;
    const toggle = $("#btn-report-more");
    const list = menu.querySelector(".menu-list");
    const setOpen = (open) => { list.hidden = !open; toggle.setAttribute("aria-expanded", open ? "true" : "false"); };
    toggle.addEventListener("click", (e) => { e.stopPropagation(); setOpen(list.hidden); });
    list.addEventListener("click", () => setOpen(false)); // close after choosing an item
    document.addEventListener("click", (e) => { if (!menu.contains(e.target)) setOpen(false); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });
  }

  function doImport() {
    const text = $("#import-text").value.trim();
    const file = $("#import-file").files && $("#import-file").files[0];
    const parse = (raw) => {
      try {
        const json = JSON.parse(raw);
        // A batch envelope (ess-findings-batch/1, or any object with a sites[] array)
        // routes to importBatch; a single findings object to importFindings.
        if (json && Array.isArray(json.sites)) importBatch(json);
        else { importFindings(json); toast("Findings imported"); }
      } catch (err) { alert("Import failed: " + err.message); }
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
  function copy(text, msg) {
    navigator.clipboard ? navigator.clipboard.writeText(text).then(() => toast(msg || "Copied")) : toast("Copy not available");
  }
  let toastTimer;
  function toast(msg) {
    let t = $("#toast");
    if (!t) { t = el("div", { id: "toast", style: "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#17242e;color:#fff;padding:9px 16px;border-radius:8px;z-index:99;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.3)" }); document.body.append(t); }
    t.textContent = msg; t.style.opacity = "1";
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
    btn.textContent = dark ? "☀️ Light" : "🌙 Dark";
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

  // ---------------------------------------------------------------- lightbox
  // One reusable full-screen overlay for viewing an image — a site/evidence photo
  // or the satellite locator map — with wheel/box-button zoom and drag to pan.
  // Replaces the old window.open(dataUrl) behaviour, which browsers render as a
  // blank page. Wikipedia reference photos instead open their source article
  // (decided in activateImage, since that's a real navigable page).
  let LB = null;
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
    const overlay = el("div", { class: "lb-overlay", id: "img-modal" }, cap, closeBtn, controls, hint, stage);
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
  }
  function hideLightbox() {
    if (!LB) return;
    LB.overlay.classList.remove("show");
    LB.img.src = "";
    document.removeEventListener("keydown", lbKeydown);
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
    wireDropzone($("#site-dropzone"), $("#site-photo-input"), (files) => addSiteImages(files));
    // Map controls are built dynamically per slot in renderMapsSections() (each with
    // its own wired inputs), so there are no static map handlers to attach here.
    $("#btn-clear-site").addEventListener("click", () => {
      $("#workspace").hidden = true;
      const wr = $("#workspace-right"); if (wr) wr.hidden = true;
      const ph = $("#report-placeholder"); if (ph) ph.hidden = false;
      $("#site-picker").scrollIntoView({ behavior: "smooth" });
      $("#station-search").focus();
    });
    $("#toggle-manual-internal").addEventListener("change", () => { renderDashboard(); renderProgress(); });
    const autoImgCb = $("#toggle-auto-images");
    if (autoImgCb) {
      autoImgCb.checked = autoImagesOn();
      autoImgCb.addEventListener("change", () => {
        setAutoImagesPref(autoImgCb.checked);
        toast(autoImgCb.checked ? "Auto-fetch reference images: on" : "Auto-fetch reference images: off");
      });
    }
    $("#btn-filter-attention").addEventListener("click", () => {
      state.filterAttention = !state.filterAttention;
      if (state.filterAttention) state.filterStatus = null;
      renderDashboard(); renderAttention(); syncFilterButton();
    });
    $("#btn-filter-unreviewed").addEventListener("click", () => {
      state.filterUnreviewed = !state.filterUnreviewed;
      renderDashboard();
    });
    $$(".sfb-btn").forEach((btn) => btn.addEventListener("click", () => {
      const s = btn.dataset.status;
      state.filterStatus = state.filterStatus === s ? null : s;
      if (state.filterStatus) state.filterAttention = false;
      renderDashboard(); renderAttention(); syncFilterButton();
    }));
    $("#btn-copy-prompt").addEventListener("click", copyFullPrompt);
    $("#btn-run-auto").addEventListener("click", runAllAuto);
    // Mirror the two free-text header fields into `state` so state is the single
    // source of truth (saveNow / reportObject read state, not the DOM) — this lets
    // the batch flow persist and review sites whose DOM isn't currently shown.
    $("#fld-date").addEventListener("change", () => { state.date = $("#fld-date").value; save(); });
    $("#fld-maintenance").addEventListener("input", () => { state.maintenance = $("#fld-maintenance").value; save(); });
    $("#btn-print").addEventListener("click", doPrint);
    $("#btn-download-html").addEventListener("click", downloadHtml);
    $("#btn-download-json").addEventListener("click", downloadJson);
    $("#btn-copy-summary").addEventListener("click", copySummary);
    $("#btn-check-report").addEventListener("click", copyReviewPrompt);
    wireOverflowMenu();
    const batchReviewBtn = $("#btn-batch-review");
    if (batchReviewBtn) batchReviewBtn.addEventListener("click", copyBatchReviewPrompt);
    const batchClearBtn = $("#btn-batch-clear");
    if (batchClearBtn) batchClearBtn.addEventListener("click", () => {
      if (state.batch && confirm("Clear the batch list? Each site's saved work is kept — this only removes the batch grouping.")) clearBatch(false);
    });
    wireBatchBuilder();

    // theme switch + split-column sizing
    const themeBtn = $("#btn-theme");
    if (themeBtn) themeBtn.addEventListener("click", toggleTheme);
    syncThemeButton();
    if (window.matchMedia) {
      try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncThemeButton); } catch (_) {}
    }
    measureTopbar();
    window.addEventListener("resize", measureTopbar);
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
      return;
    }
    $("#station-count-hint").textContent =
      `${DATA.stations.length.toLocaleString()} Bureau sites · ${DATA.sources.length} sources · data ${DATA.meta.generated_utc ? DATA.meta.generated_utc.slice(0, 10) : ""}`;
    $("#foot-meta").textContent = `${DATA.stations.length.toLocaleString()} sites · ${DATA.sources.length} sources.`;
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
      save(); refreshCard(id); renderProgress(); renderReport();
      maybeAutoFetchForSource(id, imageSubjects); // reference photos for species cards (Task 3)
      return true;
    },
    queryAla: (radius) => alaQuery(state.site.lat, state.site.lon, radius || 10),
    queryWildnet: (radius) => {
      const src = DATA.sources.find((x) => x.api && x.api.kind === "wildnet");
      return wildnetQuery(state.site.lat, state.site.lon, radius || (src && src.api && src.api.radius_km) || 10, src && src.api);
    },
    beginRun: () => { state.showAttention = false; renderAttention(); },
    endRun: () => { state.showAttention = true; renderProgress(); },
  };

  document.addEventListener("DOMContentLoaded", init);
})();
