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
  const autoImagesOn = () => { try { return localStorage.getItem(LS_AUTO_IMAGES) !== "0"; } catch (_) { return true; } };
  const setAutoImagesPref = (on) => { try { localStorage.setItem(LS_AUTO_IMAGES, on ? "1" : "0"); } catch (_) {} };
  const MAX_AUTO_IMAGES_PER_CARD = 3; // cap per source so a wordy note can't spam fetches

  // ---------------------------------------------------------------- site map
  // A satellite locator map is auto-generated for every site: tiles are fetched
  // from Esri World Imagery (keyless, CORS-enabled), stitched onto a canvas with
  // a pin at the station coordinates, and kept as a self-contained JPEG data URL
  // — so it persists in localStorage and travels through the report + every
  // export exactly like the station photos do. The user picks how many km the
  // map spans (default 100).
  const MAP_DEFAULT_KM = 100;      // starting side length (km across)
  const MAP_MIN_KM = 1, MAP_MAX_KM = 2000;
  const MAP_KM_PRESETS = [10, 25, 50, 100, 250, 500];
  const MAP_PX = 900;              // rendered square size (px) of the map image
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
  const DATA = { stations: [], sources: [], sourcesMeta: null, dropdowns: null, meta: null, weeds: [], stateBoundaries: [] };
  const state = {
    site: null,        // { name, station_num, wmo, state, delivery_group, facility_types, lat, lon, refs, primary_facility, manual }
    findings: {},      // sourceId -> { status, note, result, images: [{id,dataUrl,caption,ts}] }
    report: {},        // sectionId -> { choice, note }
    siteImages: [],    // [{id, dataUrl, caption, ts}] — general station photos
    mapKm: MAP_DEFAULT_KM, // satellite map side length (km across)
    mapLabels: true,   // overlay roads + locality/place labels on the imagery
    mapImage: null,    // { dataUrl, km, zoom, labels, lat, lon, ts } — generated locator map (persisted, exported)
    mapStatus: "idle", // transient: idle | loading | ready | error (not persisted)
    mapError: "",      // transient: last map-generation error message
    date: "",
    maintenance: "",
    filterAttention: false, // dashboard: show only Manual/Failed/Not-checked
    filterStatus: null,     // dashboard: show only sources with this one status (found/none/failed/manual/unset)
    filterUnreviewed: false, // dashboard: show only sources not yet ticked "Reviewed"
    showAttention: false,   // show the attention banner (after import / agent run)
  };
  let mapGenToken = 0; // guards against a stale async map render landing after a newer request
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
    save(); renderSiteImages(); renderReport();
  }
  function removeSiteImage(id) {
    state.siteImages = state.siteImages.filter((im) => im.id !== id);
    save(); renderSiteImages(); renderReport();
  }

  async function addFindingImages(sourceId, files) {
    const site = state.site;
    const f = state.findings[sourceId] || (state.findings[sourceId] = { status: STATUS.UNSET, note: "", result: null, images: [] });
    if (!f.images) f.images = [];
    await addImagesTo(f.images, files);
    if (state.site !== site) { toast("Site changed before the photo finished processing — discarded"); return; }
    save(); refreshCard(sourceId); renderReport();
  }
  function removeFindingImage(sourceId, imgId) {
    const f = state.findings[sourceId];
    if (!f || !f.images) return;
    f.images = f.images.filter((im) => im.id !== imgId);
    save(); refreshCard(sourceId); renderReport();
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
    save(); refreshCard(sourceId); renderReport();
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
    if (added && state.site === site) { save(); refreshCard(sourceId); renderReport(); }
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
      el("img", { src: im.dataUrl, alt: im.caption || "Photo", onclick: () => window.open(im.dataUrl, "_blank") }),
      el("button", { type: "button", class: "photo-remove", title: "Remove photo", onclick: onRemove }, "×"),
      cap,
      im.credit ? creditNode(im) : null);
  }
  // Read-only thumbnail — used in the report preview.
  function photoFigure(im, altFallback) {
    const cap = im.caption || altFallback || "";
    return el("figure", { class: "photo-thumb view" },
      el("img", { src: im.dataUrl, alt: cap || "Photo", onclick: () => window.open(im.dataUrl, "_blank") }),
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
  function photosHtml(images) {
    if (!images || !images.length) return "";
    // esc() the data URL too, not just the caption — this string is injected via
    // innerHTML (print view) / a raw <script> template (HTML export), so an
    // unescaped value could break out of the src="" attribute (stored XSS) if it
    // ever originated from an imported findings file rather than our own canvas.
    return `<div class="pr-photos">${images.map((im) => {
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
    (state.siteImages || []).forEach((im) => grid.append(renderPhotoThumb(im, () => removeSiteImage(im.id), (v) => { im.caption = v; save(); })));
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
    flushSave(); // persist any pending debounced edit for the previous site before switching
    state.site = site;
    state.findings = {};
    state.report = {};
    state.siteImages = [];
    state.mapKm = MAP_DEFAULT_KM;
    state.mapLabels = true;
    state.mapImage = null;
    state.mapStatus = "idle";
    state.mapError = "";
    state.date = new Date().toISOString().slice(0, 10);
    state.maintenance = "";
    state.filterAttention = false;
    state.filterStatus = null;
    state.filterUnreviewed = false;
    state.showAttention = false;
    restore(); // pull any saved progress for this site
    renderWorkspace();
  }

  function renderWorkspace() {
    $("#workspace").hidden = false;
    renderSummary();
    renderSiteImages();
    if ($("#map-km")) $("#map-km").value = state.mapKm;
    if ($("#map-labels")) $("#map-labels").checked = state.mapLabels;
    renderMapPresets();
    ensureSiteMap();
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
    flushSave(); // persist any pending debounced edit for the previously loaded site first
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
    const impMap = si.map && (si.map.data_url || si.map.dataUrl);
    state.mapKm = (si.map && +si.map.km) || MAP_DEFAULT_KM;
    state.mapLabels = !si.map || si.map.labels !== false; // default on unless the file says otherwise
    state.mapImage = (impMap && DATA_IMG_RE.test(impMap))
      ? { dataUrl: impMap, km: (+si.map.km) || MAP_DEFAULT_KM, zoom: si.map.zoom || 0, labels: state.mapLabels, lat, lon, ts: Date.now() }
      : null;
    state.mapStatus = state.mapImage ? "ready" : "idle";
    state.mapError = "";
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
    (json.sections || []).forEach((s) => { if (s && s.id) state.report[s.id] = { choice: s.choice || null, note: s.note || "" }; });
    state.date = si.assessment_date || new Date().toISOString().slice(0, 10);
    state.maintenance = si.site_maintenance || "";
    state.filterAttention = false;
    state.filterStatus = null;
    state.filterUnreviewed = false;
    state.showAttention = true; // surface what the agent left for the human
    renderWorkspace();
    save();
    autoFetchAfterImport(json.collection_log); // async, best-effort (Task 3)
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

  // Kick off (or re-use) the locator map for the current site. Regenerates when
  // the stored map is missing or was built for a different location/size.
  function ensureSiteMap(force) {
    const s = state.site;
    if (!s) return;
    const m = state.mapImage;
    const fresh = m && m.lat === s.lat && m.lon === s.lon && m.km === state.mapKm && m.labels === state.mapLabels;
    if (fresh && !force) { state.mapStatus = "ready"; renderSiteMap(); return; }
    generateSiteMap();
  }

  async function generateSiteMap() {
    const s = state.site;
    if (!s) return;
    const site = s, km = state.mapKm, labels = state.mapLabels, token = ++mapGenToken;
    state.mapStatus = "loading"; state.mapError = "";
    renderSiteMap();
    try {
      const map = await buildMapDataUrl(s.lat, s.lon, km, labels);
      if (token !== mapGenToken || state.site !== site) return; // superseded (site/size changed)
      state.mapImage = map; state.mapStatus = "ready"; state.mapError = "";
      save(); renderSiteMap(); renderReport();
    } catch (err) {
      if (token !== mapGenToken || state.site !== site) return;
      state.mapStatus = "error"; state.mapError = err.message || "could not load the map";
      renderSiteMap();
    }
  }

  function setMapKm(km) {
    km = Math.round(Math.max(MAP_MIN_KM, Math.min(MAP_MAX_KM, km || 0)));
    if (!km) return;
    const input = $("#map-km");
    if (input && +input.value !== km) input.value = km;
    if (km === state.mapKm && state.mapStatus === "ready") { renderMapPresets(); return; }
    state.mapKm = km;
    save();
    renderMapPresets();
    generateSiteMap();
  }

  // Toggle the road/place overlay on the locator map and re-render it.
  function setMapLabels(on) {
    on = !!on;
    if (on === state.mapLabels) return;
    state.mapLabels = on;
    const cb = $("#map-labels");
    if (cb && cb.checked !== on) cb.checked = on;
    save();
    generateSiteMap();
  }

  function renderMapPresets() {
    const wrap = $("#map-presets");
    if (!wrap) return;
    wrap.innerHTML = "";
    MAP_KM_PRESETS.forEach((km) => {
      wrap.append(el("button", {
        type: "button", class: "map-preset btn tiny" + (km === state.mapKm ? " on" : ""),
        onclick: () => setMapKm(km),
      }, `${km} km`));
    });
  }

  // Render the map area for the current state (loading / ready / error). The
  // <figure id="site-map"> lives in the summary card markup.
  function renderSiteMap() {
    const fig = $("#site-map");
    if (!fig) return;
    fig.innerHTML = "";
    const s = state.site;
    if (!s) return;
    const frame = el("div", { class: "map-frame" });

    if (state.mapStatus === "loading") {
      frame.classList.add("is-loading");
      frame.append(el("div", { class: "map-msg" }, el("span", { class: "spin" }), " Loading satellite imagery…"));
      fig.append(frame);
      return;
    }
    if (state.mapStatus === "error" || !state.mapImage) {
      frame.classList.add("is-error");
      const gmaps = `https://www.google.com/maps/@${s.lat},${s.lon},12z/data=!3m1!1e3`;
      frame.append(el("div", { class: "map-msg" },
        el("p", {}, "🛰 ", state.mapError ? `Map unavailable — ${state.mapError}.` : "Map not generated yet."),
        el("p", { class: "map-sub" }, "Satellite tiles are fetched from Esri; this needs an internet connection."),
        el("div", { class: "map-msg-actions" },
          el("button", { type: "button", class: "btn tiny", onclick: () => generateSiteMap() }, "↻ Retry"),
          el("a", { class: "btn tiny", href: gmaps, target: "_blank", rel: "noopener" }, "Open in Google Maps ↗"))));
      fig.append(frame);
      return;
    }
    // ready — scale + attribution are baked into the image itself (so they survive
    // export); the caption below just confirms the size/centre for the operator.
    const m = state.mapImage;
    frame.append(el("img", {
      class: "map-img", src: m.dataUrl, alt: `Satellite map centred on ${s.name} (${m.km} km across)`,
      title: "Open the full-size map", onclick: () => window.open(m.dataUrl, "_blank"),
    }));
    fig.append(frame);
    fig.append(el("figcaption", { class: "map-cap" },
      `Satellite locator — ${(+m.km).toLocaleString()} km across · centred on ${s.lat}, ${s.lon}`));
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

    t = table("Communities", ["community name"]); items = []; let total = 0;
    if (t) for (const r of t.data) {
      const nm = cell(r, t.col("Community Name")); if (!nm) continue; total++;
      if (lc(cell(r, t.col("Rank", "Simple Presence", "Presence"))) !== KNOWN) continue;
      const catg = cell(r, t.col("Threatened Category")), txt = cell(r, t.col("Text", "Presence Text"));
      items.push(nm + (catg ? ` — ${catg}` : "") + (txt ? ` [${txt}]` : ""));
    }
    cats.push({ title: "Listed Threatened Ecological Communities", items, total, knownOnly: true, unit: "communities" });

    t = table("Threatened Sp", ["scientific name"]); items = []; total = 0;
    if (t) for (const r of t.data) {
      const sci = cell(r, t.col("Scientific Name")), common = cell(r, t.col("Common Name"));
      if (!sci && !common) continue; total++;
      if (lc(cell(r, t.col("Simple Presence", "Rank", "Presence"))) !== KNOWN) continue;
      const name = common && lc(common) !== "null" ? `${common} (${sci})` : sci;
      const tail = [cell(r, t.col("Class")), cell(r, t.col("Threatened Category"))].filter(Boolean).join(", ");
      const txt = cell(r, t.col("Presence Text", "Text"));
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
    return { text: L.join("\n"), found };
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
      save(); refreshCard(sourceId); renderProgress(); renderReport();
      toast(res.found ? "PMST imported — MNES summary added to the notes." : "PMST imported — no MNES matters returned.");
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

    // onchange fires on blur; when auto-fetch is on and this is a species card,
    // scan the just-edited notes for subjects and pull reference photos (Task 2).
    const note = el("textarea", {
      placeholder: "Notes / evidence for the report…",
      oninput: (e) => { f.note = e.target.value; save(); },
      onchange: () => { if (autoImagesOn() && WIKI_IMAGE_CATEGORIES.has(src.category)) autoFetchFromNotes(src.id, null, true); },
    });
    note.value = f.note || "";

    let photoBlock = null;
    if (PHOTO_CATEGORIES.has(src.category)) {
      const input = el("input", { type: "file", accept: "image/*", multiple: true, hidden: true });
      const pickBtn = el("button", { type: "button", class: "pick-btn" }, "choose a file");
      const zone = el("div", { class: "dropzone small", tabindex: "0", "aria-label": "Add evidence photo — paste, drag and drop, or choose a file" },
        "📷 Evidence photo — drag & drop, paste, or ", pickBtn);
      wireDropzone(zone, input, (files) => addFindingImages(src.id, files));
      const grid = el("div", { class: "photo-grid small" });
      f.images.forEach((im) => grid.append(renderPhotoThumb(im, () => removeFindingImage(src.id, im.id), (v) => { im.caption = v; save(); })));
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
      el("div", { class: "src-note" }, note),
      photoBlock,
      el("div", { class: "src-result" + (f.result ? " show" : ""), id: `res-${src.id}`, html: f.result ? f.result.html : "" }),
    ].filter(Boolean));
    return card;
  }

  // "Reference image" control for species/subject cards: a name field (with weed
  // suggestions where we have them) + a Fetch button that pulls a labelled,
  // attributed photo from Wikipedia straight onto the card.
  function renderWikiImageRow(src) {
    const listId = `weeds-${src.id}`;
    const useList = src.category === "invasive_plants" && DATA.weeds.length;
    const inp = el("input", {
      type: "text", class: "wiki-term", autocomplete: "off", spellcheck: "false",
      placeholder: WIKI_PLACEHOLDER[src.category] || "Species or subject name…",
      list: useList ? listId : null,
      "aria-label": "Fetch a reference image from Wikipedia by name",
    });
    const btn = el("button", { type: "button", class: "btn tiny", onclick: () => fetchWikiImage(src.id, inp, btn) }, "🔎 Fetch image");
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); fetchWikiImage(src.id, inp, btn); } });
    // Auto-fetch: scan this card's notes for species/subjects and fetch a photo
    // for each — no need to type each name. (Runs automatically on note blur too
    // when "Auto-fetch reference images" is on.)
    const autoBtn = el("button", { type: "button", class: "btn tiny",
      title: "Scan this card's notes and fetch a labelled Wikipedia photo for every species/subject detected",
      onclick: () => autoFetchFromNotes(src.id, autoBtn) }, "✨ Auto from notes");
    const row = el("div", { class: "wiki-row" },
      el("span", { class: "wiki-lead" }, "🌐 Reference image from Wikipedia:"),
      inp, btn, autoBtn);
    if (useList) {
      const dl = el("datalist", { id: listId });
      DATA.weeds.forEach((w) => dl.append(el("option", { value: w })));
      row.append(dl);
    }
    return row;
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

  // Photos for a section, independent of whether a status has been set yet — a
  // photo is evidence on its own, and should still reach Print/PDF/HTML/JSON
  // exports even if the user attached it before clicking a status chip.
  function photosForSection(section) {
    const rel = sourcesForSite().filter((s) => section.cats.includes(s.category));
    return rel.flatMap((s) => ((state.findings[s.id] || {}).images || []).map((im) => ({ im, src: s })));
  }

  function renderReport() {
    const wrap = $("#report-sections");
    wrap.innerHTML = "";
    if (state.mapImage && state.mapImage.dataUrl && state.site) {
      const m = state.mapImage;
      const box = el("div", { class: "rsection" }, el("h3", {}, "Location map"));
      box.append(el("figure", { class: "report-map" },
        el("img", { src: m.dataUrl, alt: "Satellite locator map", onclick: () => window.open(m.dataUrl, "_blank") }),
        el("figcaption", {}, `Satellite locator — ${(+m.km).toLocaleString()} km across · centred on ${state.site.lat}, ${state.site.lon} · ${MAP_ATTRIB}${m.labels ? " · " + MAP_REF_ATTRIB : ""}`)));
      wrap.append(box);
    }
    if ((state.siteImages || []).length) {
      const box = el("div", { class: "rsection" }, el("h3", {}, "Site photographs"));
      const grid = el("div", { class: "photo-grid" });
      state.siteImages.forEach((im) => grid.append(photoFigure(im)));
      box.append(grid);
      wrap.append(box);
    }
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
      // Evidence photos attached to any source feeding this section
      const evImages = photosForSection(section);
      if (evImages.length) {
        const grid = el("div", { class: "photo-grid small" });
        evImages.forEach(({ im, src }) => grid.append(photoFigure(im, src.name)));
        box.append(grid);
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
  // Debounced: photos can make the per-site state multi-MB, and save() now fires
  // on every keystroke (captions, notes) — writing that synchronously per key
  // would jank typing. In-memory state (what renders/exports) is unaffected.
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
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
    const payload = {
      site: state.site, findings: state.findings, report: state.report, siteImages: state.siteImages,
      mapKm: state.mapKm, mapLabels: state.mapLabels, mapImage: state.mapImage,
      date: $("#fld-date") ? $("#fld-date").value : state.date,
      maintenance: $("#fld-maintenance") ? $("#fld-maintenance").value : state.maintenance,
    };
    try {
      localStorage.setItem(key, JSON.stringify(payload));
    } catch (err) {
      if (err && err.name !== "QuotaExceededError") { toast("Could not save locally"); return; }
      // Photos + the satellite map are the likeliest reason this exceeded the
      // quota — retry without the embedded images so findings/notes (previously
      // always small enough to save) still do. The map is regenerated on reload.
      try {
        const findings = Object.fromEntries(Object.entries(state.findings).map(([id, f]) => [id, { ...f, images: [] }]));
        localStorage.setItem(key, JSON.stringify({ ...payload, siteImages: [], mapImage: null, findings }));
        toast("Local storage is full — photos aren't saved locally (notes still are). Export your report soon.");
      } catch (_) {
        toast("Local storage is full — nothing could be saved locally. Export your report soon.");
      }
    }
  }
  function restore() {
    try {
      const raw = localStorage.getItem(LS_PREFIX + siteKey(state.site));
      if (!raw) return;
      const d = JSON.parse(raw);
      state.findings = d.findings || {};
      state.report = d.report || {};
      state.siteImages = d.siteImages || [];
      state.mapKm = d.mapKm || MAP_DEFAULT_KM;
      state.mapLabels = d.mapLabels !== false; // default on for older saves
      state.mapImage = (d.mapImage && DATA_IMG_RE.test(d.mapImage.dataUrl || "")) ? d.mapImage : null;
      state.mapStatus = state.mapImage ? "ready" : "idle";
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
        images: (state.siteImages || []).map(exportImage),
        map: state.mapImage && state.mapImage.dataUrl
          ? { km: state.mapImage.km, zoom: state.mapImage.zoom, labels: !!state.mapImage.labels,
              source: MAP_ATTRIB + (state.mapImage.labels ? " · " + MAP_REF_ATTRIB : ""), data_url: state.mapImage.dataUrl }
          : null,
      },
      sections: REPORT_SECTIONS.map((sec) => ({
        id: sec.id, title: sec.title,
        choice: (state.report[sec.id] || {}).choice || "",
        note: (state.report[sec.id] || {}).note || "",
        detail: sec.bioDetail ? (DATA.dropdowns.biosecurity_detail || {})[(state.report[sec.id] || {}).choice] || "" : "",
        images: photosForSection(sec).map(({ im, src }) => exportImage({ ...im, caption: im.caption || src.name })),
      })),
      collection_log: buildFindings(),
    };
  }

  function buildReportHtml(forPrint) {
    const r = reportObject();
    const s = r.site;
    // esc() the data URL (not just captions) — this string is injected via innerHTML
    // (print) / a raw <script>-free template (HTML export), so an unescaped value
    // could otherwise break out of src="" if a crafted findings file supplied it.
    const mapBlock = s.map && s.map.data_url
      ? `<div class="pr-sec pr-map"><h2>Location map</h2>
          <img class="pr-map-img" src="${esc(s.map.data_url)}" alt="Satellite locator map">
          <p class="pr-map-cap">Satellite locator — ${esc(String(s.map.km))} km across · centred on ${esc(s.lat)}, ${esc(s.lon)} · ${esc(s.map.source || MAP_ATTRIB)}</p></div>`
      : "";
    const siteShots = s.images && s.images.length
      ? `<div class="pr-sec"><h2>Site photographs</h2>${photosHtml(s.images)}</div>` : "";
    const secRows = r.sections.map((sec) => `<div class="pr-sec"><h2>${esc(sec.title)}</h2>
      ${sec.choice ? `<p><b>${esc(sec.choice)}</b></p>` : ""}
      ${sec.detail ? `<p>${esc(sec.detail)}</p>` : ""}
      ${sec.note ? `<p>${esc(sec.note)}</p>` : ""}
      ${photosHtml(sec.images)}</div>`).join("");
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
      .k{color:#555} .st{font-weight:700} .st-found{color:#1f7a4d}.st-none{color:#8a6d1a}.st-failed{color:#b3261e}.st-manual{color:#3a5a99}
      .pr-photos{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px} .pr-photos figure{margin:0;width:150px}
      .pr-photos img{width:100%;height:110px;object-fit:cover;border:1px solid #bbb;border-radius:4px}
      .pr-photos figcaption{font-size:10px;color:#444;margin-top:2px}
      .pr-photos figcaption .credit{display:block;font-size:9px;color:#777;margin-top:1px}
      .pr-photos figcaption .credit a{color:#777}
      .pr-map-img{display:block;width:100%;max-width:520px;border:1px solid #bbb;border-radius:6px}
      .pr-map-cap{font-size:10px;color:#444;margin:4px 0 0}</style>
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
    const mapKmInput = $("#map-km");
    if (mapKmInput) mapKmInput.addEventListener("change", () => setMapKm(parseInt(mapKmInput.value, 10)));
    const mapLabelsCb = $("#map-labels");
    if (mapLabelsCb) mapLabelsCb.addEventListener("change", () => setMapLabels(mapLabelsCb.checked));
    $("#btn-map-refresh").addEventListener("click", () => generateSiteMap());
    $("#btn-clear-site").addEventListener("click", () => { $("#workspace").hidden = true; $("#site-picker").scrollIntoView({ behavior: "smooth" }); $("#station-search").focus(); });
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
      await loadReference();
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
    beginRun: () => { state.showAttention = false; renderAttention(); },
    endRun: () => { state.showAttention = true; renderProgress(); },
  };

  document.addEventListener("DOMContentLoaded", init);
})();
