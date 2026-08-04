/* ESS Workbench — Queensland Globe map modal.
 *
 * WHAT THIS IS
 * ------------
 * A modal, genuinely interactive ArcGIS map over Queensland Government spatial
 * services, opened from the "Queensland Globe" collection card. The operator
 * uses it to SANITY-CHECK the site: is the station pin where it should be, and
 * what do the state environmental layers actually show at that point? Then they
 * capture the map they can see and it lands in the ESS report.
 *
 * It replaces an earlier workflow that opened Queensland Globe in another tab
 * and asked the operator to screenshot it. That never worked reliably — the
 * Globe share URL does not honour a layer stack, and a browser tab-capture of a
 * different tab is fragile. Everything below is drawn HERE, from the same
 * published services Queensland Globe itself draws, so what is on screen is
 * reproducible, aimed at the site, and exportable.
 *
 * HOW IT SURVIVES THE SERVICES CHANGING
 * -------------------------------------
 * Sublayer IDs on the Queensland MapServers are not stable and are not
 * documented anywhere we control. So NOTHING here depends on a hardcoded id
 * being right: every layer in the catalogue declares a name `match` and each
 * service's live layer list (`?f=json`) is read once at open and matched by
 * name. A `fallback` id is only a last resort. A layer that resolves to nothing
 * is WITHHELD and says so — in the panel and in the diagnostics — rather than
 * silently drawing the wrong dataset or nothing at all.
 *
 * EXTERNAL EVERYTHING
 * -------------------
 * The Esri bundle and every QLD service are external. Each call is bounded
 * (nothing may hang the modal), each reports its own outcome in plain language,
 * and a failure of any one layer never stops the map, the pin or the capture.
 *
 * INTERFACE (app.js owns all persistence; this module owns the map)
 *   ESSQldMap.open({ site, selection, capture, onChange, onAdd })
 *     site      { name, station_num, lat, lon }
 *     selection array of layer ids to start ticked (null = catalogue defaults)
 *     capture   the previously-captured record, so re-opening can show it back
 *     onChange  (selection)            — layer ticks changed; persist them
 *     onAdd     ({dataUrl, caption, layers, meta}) — "add to report" pressed
 *   ESSQldMap.describe(ids)  — resolve saved layer ids to {group, name, service}
 *                              rows, so a findings file that stored only ids
 *                              still produces a report appendix
 */
(() => {
  "use strict";

  // ---------------------------------------------------------------- services
  // One entry per MapServer we draw from. `label` is what the report appendix
  // and the diagnostics call it; `url` is the only thing to edit if a service
  // moves. Basemap/reference services carry the endpoints proven in the SoRT
  // site map (same host family, same CORS behaviour, canvas-exportable).
  const GIS = "https://spatial-gis.information.qld.gov.au/arcgis/rest/services/";
  const SERVICES = {
    mses:      { url: GIS + "Environment/MattersOfStateEnvironmentalSignificance/MapServer", label: "Matters of State Environmental Significance" },
    vegmgt:    { url: GIS + "Biota/VegetationManagement/MapServer",                          label: "Vegetation management (Biota)" },
    remap:     { url: GIS + "Biota/RegionalEcosystemMapping/MapServer",                      label: "Regional ecosystem mapping" },
    bpa:       { url: GIS + "Biota/BiodiversityPlanningAssessments/MapServer",               label: "Biodiversity planning assessments" },
    corridors: { url: GIS + "Biota/StatewideBiodiversityCorridors/MapServer",                label: "Statewide biodiversity corridors" },
    wetlands:  { url: GIS + "Biota/Wetlands/MapServer",                                      label: "Queensland wetland mapping" },
    aca:       { url: GIS + "Biota/AquaticConservationAssessments/MapServer",                label: "Aquatic conservation assessments" },
    parks:     { url: GIS + "Environment/ParksTerrestrialProtectedAreas/MapServer",          label: "Terrestrial protected areas" },
    marine:    { url: GIS + "Environment/ParksMarineProtectedAreas/MapServer",               label: "Marine protected areas" },
    koala:     { url: GIS + "Environment/KoalaPlan/MapServer",                               label: "Koala conservation plan" },
    fisheries: { url: GIS + "Environment/Fisheries/MapServer",                               label: "Fisheries (declared fish habitat)" },
    wetprot:   { url: GIS + "Environment/WetlandProtection/MapServer",                       label: "Wetland protection areas" },
    watbio:    { url: GIS + "Environment/WaterAndWetlandBiodiversity/MapServer",             label: "Water & wetland biodiversity" },
    esa:       { url: GIS + "Environment/EnvironmentallySensitiveAreasCategoryA/MapServer",  label: "Environmentally sensitive areas (category A)" },
    contours:  { url: GIS + "Elevation/Contours/MapServer",                                  label: "LiDAR contours" },
    cadastre:  { url: GIS + "PlanningCadastre/LandParcelPropertyFramework/MapServer",        label: "Land parcel & property framework (DCDB)" },
    transport: { url: GIS + "Transportation/OtherTransport/MapServer",                       label: "Rail network" },
    admin:     { url: GIS + "Boundaries/AdminBoundariesFramework/MapServer",                 label: "Administrative boundaries" },
    labels:    { url: GIS + "Basemaps/QldImageryLabel/MapServer",                            label: "Imagery labels" },
  };
  // Aerial imagery lives on the image server, not the GIS server.
  const IMAGERY_URL = "https://spatial-img.information.qld.gov.au/arcgis/rest/services/Basemaps/LatestStateProgram_AllUsers/ImageServer";

  const CFG = {
    esriBase: "https://js.arcgis.com/4.31/",
    attribution: "© State of Queensland (Department of Natural Resources and Mines) — CC BY 4.0",
    // View is CONSTRUCTED at the station coordinate at this zoom, so it never
    // renders a state-wide default extent and never issues whole-of-Queensland
    // exportImage requests before it is framed.
    anchorZoom: 15,
    // Dynamic MapImageLayers are unreadable zoomed right out and asking them for
    // a whole-state extent is what makes them slow. Suppress the thematic layers
    // above this scale and show a hint instead of silently drawing nothing.
    thematicMinScale: 250000,
    // Cadastre / contours are only meaningful close in and are heavy far out.
    detailMinScale: 20000,
    // Everything external is bounded. The Esri bundle is a much bigger download
    // than a service metadata call, so it gets more headroom — still bounded.
    // `viewReady` is deliberately LONGER than `layer`: the view takes its
    // projection from the imagery layer, so it must not be declared wedged
    // while that layer's own bound is still running (see readyView).
    timeouts: { esri: 15000, meta: 9000, layer: 12000, view: 9000, viewReady: 14000, identify: 11000, legend: 9000 },
    // The projection these Queensland basemap/tile services publish in, named
    // outright only when the imagery has failed to hand the view one.
    fallbackWkid: 102100,
    thematicOpacity: 0.62,
    // Click-to-identify: how many screen pixels either side of the click still
    // count as "at this point", and how much of one feature's attribute table
    // the popup may show before it stops being readable.
    identifyTolerance: 4,
    identifyMaxAttrs: 6,
    // A published legend can carry hundreds of classes (broad vegetation
    // groups). The appendix only has to explain what the map actually shows, so
    // the swatches per layer are capped — and the appendix says when it capped.
    legendMaxPerLayer: 8,
    // Draw order (lower = further down the stack). Pins live in view.graphics
    // and are always above every layer here.
    z: { imagery: 0, thematic: 10, cadastre: 60, contour: 65, rail: 70, labels: 90 },
    pinColour: [214, 40, 40],
  };

  /* ------------------------------------------------------------- catalogue
     Grouped so the panel reads like Queensland Globe's own catalogue. Each
     layer:
       id       stable key — what gets persisted and what the appendix cites
       name     what the operator and the report call it
       svc      key into SERVICES
       match    regex tried against the service's live sublayer names
       fallback sublayer id used only if the name match finds nothing
       whole    draw the ENTIRE service instead of one sublayer (for services
                that exist to be drawn whole — the imagery label service is all
                label sublayers, so picking one of them is meaningless)
       on       ticked by default
     Keep `match` loose enough to survive a wording change and tight enough not
     to catch a neighbouring dataset — it is checked against the WHOLE sublayer
     name, and the first non-group match wins. */
  const LAYER_GROUPS = [
    {
      id: "mses", title: "Matters of State Environmental Significance", colour: "#6a1b9a",
      note: "The MSES stack — the layer set most ESS findings are argued from.",
      layers: [
        { id: "mses-estates",        name: "MSES protected area — estates",                       svc: "mses", match: /protected area.*estate/i,                          on: true },
        { id: "mses-refuges",        name: "MSES protected area — nature refuges",                svc: "mses", match: /protected area.*(nature refuge)/i, fallback: 2,    on: true },
        { id: "mses-swr",            name: "MSES protected area — special wildlife reserves",     svc: "mses", match: /protected area.*special wildlife/i,                on: true },
        { id: "mses-marine",         name: "MSES marine park — highly protected",                 svc: "mses", match: /marine park.*highly protected/i,                   on: true },
        { id: "mses-fha",            name: "MSES declared fish habitat area — A and B areas",     svc: "mses", match: /fish habitat area/i,                               on: true },
        { id: "mses-veg-b",          name: "MSES regulated vegetation — category B, endangered or of concern", svc: "mses", match: /regulated vegetation.*category b/i, fallback: 15, on: true },
        { id: "mses-veg-c",          name: "MSES regulated vegetation — category C, endangered or of concern", svc: "mses", match: /regulated vegetation.*category c/i, fallback: 16, on: true },
        { id: "mses-veg-r",          name: "MSES regulated vegetation — category R, GBR riverine",svc: "mses", match: /regulated vegetation.*category r/i,                on: true },
        { id: "mses-veg-ehab",       name: "MSES regulated vegetation — essential habitat",       svc: "mses", match: /regulated vegetation.*essential habitat/i, fallback: 18, on: true },
        { id: "mses-veg-wetland",    name: "MSES regulated vegetation — 100 m from wetland",      svc: "mses", match: /regulated vegetation.*(100\s*m|wetland)/i, fallback: 19, on: true },
        { id: "mses-veg-watercourse",name: "MSES regulated vegetation — defined watercourse",     svc: "mses", match: /regulated vegetation.*watercourse/i,                on: true },
        { id: "mses-hes-wetland",    name: "MSES high ecological significance wetlands",          svc: "mses", match: /high ecological significance wetland/i, fallback: 11, on: true },
        { id: "mses-hev-wetland",    name: "MSES declared high ecological value waters — wetland",     svc: "mses", match: /high ecological value.*wetland/i,               on: true },
        { id: "mses-hev-watercourse",name: "MSES declared high ecological value waters — watercourse", svc: "mses", match: /high ecological value.*watercourse/i,           on: true },
        { id: "mses-wh-ev",          name: "MSES wildlife habitat — endangered or vulnerable",    svc: "mses", match: /wildlife habitat.*(endangered|vulnerable)/i,       on: true },
        { id: "mses-wh-slc",         name: "MSES wildlife habitat — special least concern animal",svc: "mses", match: /wildlife habitat.*least concern/i,                  on: true },
        { id: "mses-wh-koala-core",  name: "MSES wildlife habitat — SEQ koala habitat, core",     svc: "mses", match: /wildlife habitat.*koala.*core/i, fallback: 23,      on: true },
        { id: "mses-wh-koala-lr",    name: "MSES wildlife habitat — SEQ koala habitat, locally refined", svc: "mses", match: /wildlife habitat.*koala.*(locally refined|refined)/i, on: true },
        { id: "mses-wh-turtle",      name: "MSES wildlife habitat — sea turtle nesting areas",    svc: "mses", match: /wildlife habitat.*turtle/i,                        on: true },
        { id: "mses-offset-reg",     name: "MSES legally secured offset area — offset register",  svc: "mses", match: /offset area.*register/i,                           on: false },
        { id: "mses-offset-veg",     name: "MSES legally secured offset area — vegetation offsets", svc: "mses", match: /offset area.*vegetation/i,                       on: false },
        { id: "mses-sea",            name: "MSES strategic environmental area — designated precinct", svc: "mses", match: /strategic environmental area/i,                 on: false },
      ],
    },
    {
      id: "veg", title: "Vegetation & habitat", colour: "#2e7d32",
      note: "Vegetation Management Act mapping and regional ecosystems.",
      layers: [
        { id: "veg-trigger",   name: "Protected plants flora survey trigger map",     svc: "vegmgt", match: /(flora survey )?trigger map|protected plant/i, fallback: 201, on: true },
        { id: "veg-ehab",      name: "Essential habitat map",                         svc: "vegmgt", match: /essential habitat/i, fallback: 5,               on: true },
        { id: "veg-rvm-a",     name: "Regulated vegetation management map — category A", svc: "vegmgt", match: /category a\b/i,                              on: false },
        { id: "veg-rvm-b",     name: "Regulated vegetation management map — category B (remnant)", svc: "vegmgt", match: /category b\b/i,                    on: true },
        { id: "veg-rvm-c",     name: "Regulated vegetation management map — category C (high-value regrowth)", svc: "vegmgt", match: /category c\b/i,        on: true },
        { id: "veg-rvm-r",     name: "Regulated vegetation management map — category R (regrowth watercourse)", svc: "vegmgt", match: /category r\b/i,       on: false },
        { id: "veg-watercourse", name: "Vegetation management watercourse & drainage",svc: "vegmgt", match: /watercourse|drainage/i,                         on: false },
        { id: "re-status",     name: "Regional ecosystems — biodiversity status",     svc: "remap",  match: /biodiversity status/i,                          on: false },
        { id: "re-vmstatus",   name: "Regional ecosystems — vegetation management status", svc: "remap", match: /vegetation management (act )?status/i,      on: false },
        { id: "re-bvg",        name: "Broad vegetation groups",                       svc: "remap",  match: /broad vegetation group/i,                       on: false },
        { id: "esa-a",         name: "Environmentally sensitive areas — category A",  svc: "esa",    match: /environmentally sensitive|category a/i,         on: false },
      ],
    },
    {
      id: "protected", title: "Protected places", colour: "#00695c",
      note: "Parks, reserves, forests and marine protected areas.",
      layers: [
        { id: "pa-estate",     name: "Protected areas — national parks, conservation parks, reserves", svc: "parks",  match: /protected area|national park|conservation park/i, on: true },
        { id: "pa-forest",     name: "State forests & timber reserves",               svc: "parks",  match: /state forest|timber reserve|forest reserve/i,  on: true },
        { id: "pa-refuge",     name: "Nature refuges & special wildlife reserves",    svc: "parks",  match: /nature refuge|special wildlife/i,               on: true },
        { id: "pa-marine",     name: "Marine parks & zoning",                         svc: "marine", match: /marine park/i,                                  on: false },
        { id: "pa-gbr",        name: "Great Barrier Reef Coast Marine Park zones",    svc: "marine", match: /great barrier reef/i,                           on: false },
        { id: "pa-fha",        name: "Declared fish habitat areas",                   svc: "fisheries", match: /fish habitat area/i,                         on: false },
      ],
    },
    {
      id: "wildlife", title: "Wildlife habitat", colour: "#ef6c00",
      note: "Koala planning layers under the Koala Conservation Plan.",
      layers: [
        { id: "koala-priority", name: "Koala priority area",                          svc: "koala", match: /koala priority/i,                                on: true },
        { id: "koala-core",     name: "Core koala habitat area",                      svc: "koala", match: /koala habitat.*core|core.*koala habitat/i,       on: true },
        { id: "koala-lr",       name: "Locally refined koala habitat area",           svc: "koala", match: /locally refined/i,                               on: true },
        { id: "koala-district", name: "Koala district / conservation plan boundary",  svc: "koala", match: /district|conservation plan|koala area/i,         on: false },
      ],
    },
    {
      id: "water", title: "Water & wetlands", colour: "#0277bd",
      note: "Wetland mapping, wetland protection areas and aquatic values.",
      layers: [
        { id: "wet-areas",     name: "Wetland areas",                                 svc: "wetlands", match: /wetland area/i,                               on: true },
        { id: "wet-lines",     name: "Wetland lines",                                 svc: "wetlands", match: /wetland line/i,                               on: false },
        { id: "wet-points",    name: "Wetland points",                                svc: "wetlands", match: /wetland point/i,                              on: false },
        { id: "wet-protection",name: "Wetland protection area",                       svc: "wetprot",  match: /wetland protection|wpa/i,                     on: true },
        { id: "wet-hes",       name: "Wetlands of high ecological significance",      svc: "watbio",   match: /high ecological significance/i,               on: true },
        { id: "wet-hev",       name: "Declared high ecological value waters",         svc: "watbio",   match: /high ecological value/i,                      on: false },
        { id: "aca-riverine",  name: "Aquatic conservation assessment — riverine",    svc: "aca",      match: /riverine/i,                                   on: false },
        { id: "aca-nonriverine", name: "Aquatic conservation assessment — non-riverine", svc: "aca",   match: /non[- ]?riverine|palustrine|lacustrine/i,     on: false },
      ],
    },
    {
      id: "biodiversity", title: "Biodiversity assessments", colour: "#7cb342",
      note: "BPA significance mapping and statewide corridors.",
      layers: [
        { id: "bpa-state",     name: "Biodiversity planning assessment — state significance",    svc: "bpa",       match: /state significance|state.*biodiversity significance/i, on: false },
        { id: "bpa-regional",  name: "Biodiversity planning assessment — regional significance", svc: "bpa",       match: /regional significance/i,           on: false },
        { id: "corridor-state",name: "Statewide biodiversity corridors — state",                 svc: "corridors", match: /state/i,                           on: false },
        { id: "corridor-regional", name: "Statewide biodiversity corridors — regional",          svc: "corridors", match: /regional/i,                        on: false },
      ],
    },
    {
      id: "reference", title: "Reference & terrain", colour: "#546e7a",
      note: "The base context: cadastre, contours, rail and place labels.",
      layers: [
        { id: "ref-parcels",   name: "Property boundaries (cadastre)",                svc: "cadastre",  match: /^(?!.*road).*(parcel|property|lot)/i, fallback: 4, on: false, detail: true },
        { id: "ref-road",      name: "Road parcels (road reserve)",                   svc: "cadastre",  match: /road/i,                                on: false, detail: true },
        { id: "ref-contour5",  name: "Contours — 5 m LiDAR",                          svc: "contours",  match: /(?:^|[^0-9])5\s*(?:m\b|met(?:re|er)s?\b)/i, fallback: 20, on: false, detail: true },
        { id: "ref-contour10", name: "Contours — 10 m LiDAR",                         svc: "contours",  match: /(?:^|[^0-9])10\s*(?:m\b|met(?:re|er)s?\b)/i, fallback: 10, on: false, detail: true },
        { id: "ref-rail",      name: "Railway lines",                                 svc: "transport", match: /rail|tram|siding|cane/i,               on: false },
        { id: "ref-locality",  name: "Localities & administrative boundaries",        svc: "admin",     match: /localit|suburb/i,                      on: false },
        { id: "ref-labels",    name: "Map labels (place & road names)",               svc: "labels",    whole: true,                                   on: true },
      ],
    },
  ];
  // Flat index — id → { layer, group }.
  const LAYER_INDEX = {};
  LAYER_GROUPS.forEach((g) => g.layers.forEach((l) => { LAYER_INDEX[l.id] = { layer: l, group: g }; }));
  const DEFAULT_SELECTION = () => LAYER_GROUPS.flatMap((g) => g.layers.filter((l) => l.on).map((l) => l.id));

  // A sublayer name that is not a real drawable layer — an annotation or label
  // companion — should never win a name match over the dataset itself.
  const NOISE = /annotation|label|^text$/i;

  // ------------------------------------------------------------------ helpers
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
    return n;
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  const clock = (ts) => new Date(ts || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const fmtCoord = (lat, lon) => `${(+lat).toFixed(6)}, ${(+lon).toFixed(6)}`;

  // A timeout worded so a non-developer can relay it, never a raw TypeError.
  function timeoutError(label, ms) {
    const e = new Error(`${label} did not respond within ${Math.round(ms / 1000)} s`);
    e.isTimeout = true;
    return e;
  }
  function withTimeout(promise, ms, label) {
    let timer;
    const t = new Promise((_, rej) => { timer = setTimeout(() => rej(timeoutError(label, ms)), ms); });
    return Promise.race([promise, t]).finally(() => clearTimeout(timer));
  }
  // A JSON fetch that actually ABORTS on timeout (so a hung request is cancelled,
  // not merely ignored) and reports how long it took.
  async function fetchJson(url, label, ms) {
    const start = now();
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
    try {
      const res = await fetch(url, ctrl ? { cache: "no-store", signal: ctrl.signal } : { cache: "no-store" });
      return { json: await res.json(), ms: Math.round(now() - start) };
    } catch (e) {
      const err = e && e.name === "AbortError" ? timeoutError(label, ms) : e;
      err._ms = Math.round(now() - start);
      throw err;
    } finally { if (timer) clearTimeout(timer); }
  }

  // ------------------------------------------------------------- module state
  // The Esri bundle and the resolved service metadata are cached for the page's
  // lifetime — re-opening the modal must not re-download or re-probe anything.
  const M = {
    esri: null, esriPromise: null,
    serviceCache: {},          // svcKey -> { layers:[{id,name,group}], error } | Promise
    legendCache: {},           // svcKey -> Promise of the /legend read
    legend: {},                // svcKey -> { sublayerId: [{label, values, swatch}] } (resolved)
    overlay: null, view: null, esriMap: null,
    hosts: {},                 // cached DOM references inside the overlay
    site: null,
    selection: new Set(),
    resolved: {},              // layerId -> { sublayer, via, status, note }
    svcLayers: {},             // svcKey -> the MapImageLayer on the map
    pinGraphic: null,
    probe: null,               // the open "what's here?" answer (see runProbe)
    probeToken: 0,             // only the newest click's answers are rendered
    probeGraphic: null,        // the ring marking the point that was asked about
    userFramed: false,         // the operator has panned/zoomed — stop auto-fitting
    shot: { dataUrl: null, valid: false, at: null, meta: null },
    capture: null,             // the record handed back to app.js on "add to report"
    hooks: {},                 // { onChange, onAdd }
    diag: null,
    open: false,
    release: null,             // trapFocus() teardown while the modal is open
    building: false,
  };

  /* ---- diagnostics -----------------------------------------------------
     The operator has no DevTools. Every external dependency reports its own
     outcome here in words, and the panel's Copy button hands the whole thing
     over as plain text. Nothing is console-only. */
  function freshDiag() {
    return { esri: { status: "pending" }, imagery: { status: "pending" }, services: {}, legends: {}, layers: {}, screenshot: { status: "idle" }, identify: { status: "idle" }, log: [] };
  }
  function dlog(msg) {
    if (!M.diag) M.diag = freshDiag();
    M.diag.log.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (M.diag.log.length > 300) M.diag.log.shift();
    renderDiagnostics();
  }
  function setDiag(key, fields, msg) {
    if (!M.diag) M.diag = freshDiag();
    M.diag[key] = Object.assign(M.diag[key] || {}, fields);
    if (msg) dlog(msg); else renderDiagnostics();
  }

  // -------------------------------------------------------------- Esri loader
  // Injected once, on demand — the ESS workbench must stay a fast, dependency-free
  // page for the 95% of sessions that never open the map.
  function loadEsri() {
    if (M.esri) return Promise.resolve(M.esri);
    if (M.esriPromise) return M.esriPromise;
    const start = now();
    dlog(`Loading the Esri map library from ${CFG.esriBase} …`);
    const load = new Promise((resolve, reject) => {
      try {
        const css = document.createElement("link");
        css.rel = "stylesheet";
        css.href = `${CFG.esriBase}esri/themes/light/main.css`;
        document.head.appendChild(css);
        const s = document.createElement("script");
        s.src = CFG.esriBase;
        s.async = true;
        s.onload = () => {
          if (!window.require) { reject(new Error("Esri loader did not initialise")); return; }
          window.require([
            "esri/Map", "esri/views/MapView", "esri/layers/ImageryTileLayer", "esri/layers/ImageryLayer",
            "esri/layers/MapImageLayer", "esri/Graphic", "esri/geometry/SpatialReference",
            "esri/geometry/projection", "esri/core/reactiveUtils", "esri/widgets/ScaleBar",
          ], (Map, MapView, ImageryTileLayer, ImageryLayer, MapImageLayer, Graphic, SpatialReference, projection, reactiveUtils, ScaleBar) => {
            M.esri = { Map, MapView, ImageryTileLayer, ImageryLayer, MapImageLayer, Graphic, SpatialReference, projection, reactiveUtils, ScaleBar };
            // Kicked off now, not awaited here: it primes Esri's projection
            // engine so the view can place — and locate on screen — a lat/lon pin
            // even when a service hands the map a CRS that isn't Web Mercator.
            projection.load().catch(() => {});
            resolve(M.esri);
          }, reject);
        };
        s.onerror = () => reject(new Error("Could not load the Esri map library (this map needs a network connection)"));
        document.head.appendChild(s);
      } catch (e) { reject(e); }
    });
    M.esriPromise = withTimeout(load, CFG.timeouts.esri, "Esri map library (js.arcgis.com)")
      .then((esri) => { setDiag("esri", { status: "loaded", ms: Math.round(now() - start) }, "Esri map library loaded."); return esri; })
      .catch((err) => {
        M.esriPromise = null; // allow a later retry
        setDiag("esri", { status: err.isTimeout ? "timed out" : "failed", ms: Math.round(now() - start), note: err.message },
          `Esri map library ${err.isTimeout ? "timed out" : "failed"}: ${err.message}`);
        throw err;
      });
    return M.esriPromise;
  }

  /* ---- service metadata + name resolution -------------------------------
     Read each service's layer list ONCE and index it. Group layers (which carry
     no features of their own) and annotation/label companions are recorded but
     never allowed to win a name match, so "Wetland areas" resolves to the
     polygon dataset rather than its label layer. */
  function loadService(key) {
    if (M.serviceCache[key]) return M.serviceCache[key];
    const svc = SERVICES[key];
    const start = now();
    // NOTE the failure path below deliberately does NOT stay cached: a network
    // blip must not withhold a whole service for the rest of the page's life.
    const p = fetchJson(`${svc.url}?f=json`, `${svc.label} service metadata`, CFG.timeouts.meta)
      .then(({ json, ms }) => {
        const layers = (json.layers || []).map((l) => ({
          id: l.id,
          name: String(l.name || ""),
          group: Array.isArray(l.subLayerIds) && l.subLayerIds.length > 0,
          minScale: l.minScale || 0,
          maxScale: l.maxScale || 0,
        }));
        const out = { layers, error: null, ms };
        setDiag("services", { [key]: { status: "read", ms, count: layers.length } },
          `${svc.label}: read ${layers.length} sublayers in ${(ms / 1000).toFixed(1)} s.`);
        return out;
      })
      .catch((e) => {
        const out = { layers: [], error: e.message || "error", ms: e._ms || Math.round(now() - start) };
        setDiag("services", { [key]: { status: e.isTimeout ? "timed out" : "failed", ms: out.ms, note: out.error } },
          `${svc.label}: metadata ${e.isTimeout ? "timed out" : "failed"} — ${out.error}. Its layers are withheld.`);
        delete M.serviceCache[key];   // a blip must not withhold this service forever
        return out;
      });
    M.serviceCache[key] = p;
    return p;
  }

  /* ---- published symbology (the legend) ---------------------------------
     Every ArcGIS MapServer publishes the symbols it draws with at
     `/legend?f=json`, as the very PNG swatches the server paints into the map
     image. Reading them is what lets the click popup and the report appendix
     show the operator the actual colour and pattern on the picture instead of
     a colour we invented in the panel — the mismatch between our group colours
     and the map's own shading is exactly what made the map unreadable.

     Failure here is survivable and deliberately quiet: a layer with no legend
     still identifies, still draws and still reaches the appendix; it just does
     so as a name without a swatch. */
  function loadLegend(key) {
    if (M.legendCache[key]) return M.legendCache[key];
    const svc = SERVICES[key];
    const p = fetchJson(`${svc.url}/legend?f=json`, `${svc.label} legend`, CFG.timeouts.legend)
      .then(({ json, ms }) => {
        const byLayer = {};
        (json.layers || []).forEach((l) => {
          const rows = (l.legend || []).map((e) => ({
            label: String(e.label == null ? "" : e.label),
            // Unique-value renderers publish the attribute value(s) each swatch
            // stands for — the only reliable way to pick the RIGHT swatch for
            // an identified feature rather than the layer's first one.
            values: Array.isArray(e.values) && e.values.length ? e.values.map((v) => String(v)) : null,
            swatch: e.imageData ? `data:${e.contentType || "image/png"};base64,${e.imageData}` : "",
          })).filter((e) => e.swatch);
          if (rows.length) byLayer[l.layerId] = rows;
        });
        M.legend[key] = byLayer;
        setDiag("legends", { [key]: { status: "read", ms, count: Object.keys(byLayer).length } },
          `${svc.label}: read symbology for ${Object.keys(byLayer).length} sublayers.`);
        return byLayer;
      })
      .catch((e) => {
        delete M.legendCache[key];  // a blip must not withhold the symbology forever
        setDiag("legends", { [key]: { status: e.isTimeout ? "timed out" : "failed", note: e.message } },
          `${svc.label}: symbology unavailable — ${e.message}. Its layers appear without a swatch.`);
        return {};
      });
    M.legendCache[key] = p;
    return p;
  }

  // Read the legend of every service with a ticked, resolved layer. Started
  // (not awaited) as the map draws, and awaited — bounded — before a capture,
  // so the appendix gets swatches without ever making the map wait for them.
  function ensureLegends() {
    const keys = [...new Set(Object.keys(LAYER_INDEX)
      .filter((id) => M.selection.has(id) && M.resolved[id] && M.resolved[id].status === "ok")
      .map((id) => LAYER_INDEX[id].layer.svc))];
    return Promise.all(keys.map((k) => loadLegend(k).catch(() => ({}))));
  }

  // The swatches for one catalogue layer, as published by its service. Empty
  // for a whole-service or group-layer entry: those have no single sublayer to
  // key on, and inventing one would put the wrong colour in the report.
  function legendEntries(id) {
    const hit = LAYER_INDEX[id], r = M.resolved[id];
    if (!hit || !r || r.status !== "ok" || r.sublayer == null) return [];
    const byLayer = M.legend[hit.layer.svc];
    return (byLayer && byLayer[r.sublayer]) || [];
  }

  // The single swatch that matches ONE identified feature. Returns null when it
  // cannot be certain — a wrong colour beside a layer name is worse than none.
  function swatchForFeature(id, result) {
    const entries = legendEntries(id);
    if (!entries.length) return null;
    if (entries.length === 1) return entries[0];
    const candidates = [String((result && result.value) || "")]
      .concat(Object.values((result && result.attributes) || {}).map((v) => String(v == null ? "" : v)))
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);
    for (const c of candidates) {
      const byValue = entries.find((e) => e.values && e.values.some((v) => v.trim().toLowerCase() === c));
      if (byValue) return byValue;
      const byLabel = entries.find((e) => e.label.trim().toLowerCase() === c);
      if (byLabel) return byLabel;
    }
    return null;
  }

  // Match one catalogue entry against a service's live sublayer names. Returns
  // { sublayer, via } or null. `via` records HOW it resolved so the diagnostics
  // can distinguish a confident name match from a fallback guess.
  function matchSublayer(entry, meta) {
    // A whole-service layer needs no name match — it IS the service. It still
    // requires the metadata to have read, so an unreachable service is withheld
    // rather than added as a layer that will never draw.
    if (entry.whole) return { sublayer: null, via: "whole service" };
    const usable = meta.layers.filter((l) => !l.group && !NOISE.test(l.name));
    const hit = usable.find((l) => entry.match.test(l.name));
    if (hit) return { sublayer: hit.id, via: `name match "${hit.name}"` };
    // A group-layer name match is still better than nothing: draw the group.
    const grp = meta.layers.find((l) => l.group && entry.match.test(l.name));
    if (grp) return { sublayer: grp.id, via: `group layer "${grp.name}"` };
    if (entry.fallback != null && meta.layers.some((l) => l.id === entry.fallback)) {
      const f = meta.layers.find((l) => l.id === entry.fallback);
      return { sublayer: entry.fallback, via: `fallback id ${entry.fallback} ("${f.name}")` };
    }
    return null;
  }

  // Resolve every SELECTED layer against its service. Runs in parallel per
  // service; a service that failed simply withholds its layers with a reason.
  async function resolveSelected() {
    const wanted = [...M.selection].map((id) => LAYER_INDEX[id]).filter(Boolean);
    const svcKeys = [...new Set(wanted.map(({ layer }) => layer.svc))];
    const metas = {};
    await Promise.all(svcKeys.map(async (k) => { metas[k] = await loadService(k); }));
    for (const { layer } of wanted) {
      if (M.resolved[layer.id] && M.resolved[layer.id].status === "ok") continue;
      const meta = metas[layer.svc];
      if (!meta) continue;
      if (meta.error) {
        M.resolved[layer.id] = { status: "service-failed", note: meta.error };
        continue;
      }
      const m = matchSublayer(layer, meta);
      if (!m) {
        M.resolved[layer.id] = { status: "not-found", note: "no sublayer on this service matched the layer name" };
        dlog(`"${layer.name}" — no matching sublayer on ${SERVICES[layer.svc].label}; withheld.`);
        continue;
      }
      M.resolved[layer.id] = { status: "ok", sublayer: m.sublayer, via: m.via };
    }
    return M.resolved;
  }

  // ------------------------------------------------------------- map plumbing
  function insertOrdered(map, layer, z) {
    layer.__z = z;
    let idx = 0;
    map.layers.forEach((l) => { if ((l.__z != null ? l.__z : 99) <= z) idx++; });
    map.add(layer, idx);
  }

  // One MapImageLayer per SERVICE carrying every selected sublayer of that
  // service, rather than one layer per sublayer: it is a single exportImage
  // round-trip per service instead of forty, which is the difference between a
  // map that draws and a map that times out. Toggling a layer flips the
  // sublayer's `visible` on the layer that already exists.
  function serviceSublayers(svcKey) {
    const rows = [];
    for (const id of Object.keys(LAYER_INDEX)) {
      const { layer } = LAYER_INDEX[id];
      if (layer.svc !== svcKey) continue;
      const r = M.resolved[id];
      if (!r || r.status !== "ok") continue;
      if (layer.whole) continue;   // handled by wholeService(), not per-sublayer
      rows.push({ id: r.sublayer, visible: M.selection.has(id), title: layer.name, __essId: id });
    }
    // One sublayer id can back two catalogue entries; keep the visible one.
    const seen = new Map();
    rows.forEach((r) => {
      const prev = seen.get(r.id);
      if (!prev || (!prev.visible && r.visible)) seen.set(r.id, r);
    });
    return [...seen.values()];
  }

  // A service drawn whole: is any `whole` entry for it resolved AND ticked?
  function wholeService(svcKey) {
    return Object.keys(LAYER_INDEX).some((id) => {
      const { layer } = LAYER_INDEX[id];
      const r = M.resolved[id];
      return layer.svc === svcKey && layer.whole && M.selection.has(id) && r && r.status === "ok";
    });
  }

  async function buildServiceLayer(map, svcKey) {
    const subs = serviceSublayers(svcKey);
    const whole = wholeService(svcKey);
    if (!subs.length && !whole) return null;
    const svc = SERVICES[svcKey];
    const isDetail = svcKey === "cadastre" || svcKey === "contours";
    const isReference = svcKey === "labels" || svcKey === "transport";
    const start = now();
    try {
      const opts = {
        url: svc.url,
        title: svc.label,
        opacity: isReference ? 0.95 : CFG.thematicOpacity,
        minScale: isReference ? 0 : (isDetail ? CFG.detailMinScale : CFG.thematicMinScale),
        maxScale: 0,
        imageFormat: "png32",
      };
      // Omitting `sublayers` entirely tells the API to draw the service's own
      // default sublayer set — which is what "draw it whole" means.
      if (!whole) opts.sublayers = subs.map((s) => ({ id: s.id, visible: s.visible }));
      const layer = new M.esri.MapImageLayer(opts);
      await withTimeout(layer.load(), CFG.timeouts.layer, `${svc.label} layer`);
      const z = svcKey === "labels" ? CFG.z.labels
        : svcKey === "transport" ? CFG.z.rail
          : svcKey === "contours" ? CFG.z.contour
            : svcKey === "cadastre" ? CFG.z.cadastre
              : CFG.z.thematic;
      insertOrdered(map, layer, z);
      M.svcLayers[svcKey] = layer;
      const what = whole ? "the whole service" : `sublayers ${subs.map((s) => s.id).join(", ")}`;
      setDiag("services", { [svcKey]: Object.assign({}, (M.diag.services || {})[svcKey], { status: "drawn", drawnMs: Math.round(now() - start), sublayers: whole ? "all" : subs.map((s) => s.id).join(", ") }) },
        `${svc.label}: drawn with ${what}.`);
      return layer;
    } catch (e) {
      setDiag("services", { [svcKey]: Object.assign({}, (M.diag.services || {})[svcKey], { status: e.isTimeout ? "timed out" : "failed", note: e.message }) },
        `${svc.label}: layer ${e.isTimeout ? "timed out" : "failed"} — ${e.message}. Other layers are unaffected.`);
      banner(`${svc.label} did not load (${e.message}). The rest of the map is unaffected.`, "warn");
      return null;
    }
  }

  // The aerial base. Tagged with its z-order at construction because it goes on
  // the map BEFORE the view exists (see buildView) rather than through
  // insertOrdered(), and everything else still has to stack above it.
  function newImageryLayer(Cls) {
    const layer = new Cls({ url: IMAGERY_URL, title: "Queensland aerial imagery" });
    layer.__z = CFG.z.imagery;
    return layer;
  }

  // `imagery` is ALREADY on the map — buildView put it there so the view had a
  // projection to adopt. This reports its outcome and, if the tile cache is
  // unavailable, swaps in the slower dynamic layer.
  async function loadImagery(map, imagery) {
    const start = now();
    // The ImageServer publishes a fused tile cache, so ImageryTileLayer (which
    // reads the pre-built /tile/{z}/{y}/{x}) is right and much faster than a
    // dynamic exportImage per pan. A dynamic ImageryLayer is the fallback.
    try {
      await withTimeout(imagery.load(), CFG.timeouts.layer, "Aerial imagery (ImageServer)");
      setDiag("imagery", { status: "loaded", ms: Math.round(now() - start), mode: "ImageryTileLayer (tiled)" }, "Aerial imagery loaded (tiled).");
      return imagery;
    } catch (e) {
      // A tiled layer that never loaded contributes nothing but a projection the
      // view may still be waiting on — take it off the map before trying again.
      try { map.remove(imagery); } catch (_) {}
      try {
        const dyn = newImageryLayer(M.esri.ImageryLayer);
        await withTimeout(dyn.load(), CFG.timeouts.layer, "Aerial imagery (ImageServer, dynamic)");
        insertOrdered(map, dyn, CFG.z.imagery);
        setDiag("imagery", { status: "loaded", ms: Math.round(now() - start), mode: "ImageryLayer (dynamic fallback)" }, "Tiled imagery unavailable; loaded the slower dynamic imagery instead.");
        banner("Aerial imagery loaded in slower dynamic mode (the tiled service was unavailable).", "warn");
        return dyn;
      } catch (e2) {
        setDiag("imagery", { status: e.isTimeout ? "timed out" : "failed", ms: Math.round(now() - start), note: e.message }, `Aerial imagery ${e.isTimeout ? "timed out" : "failed"}: ${e.message}`);
        banner(`Aerial imagery did not load (${e.message}). Layers and the pin still draw.`, "error");
        return null;
      }
    }
  }

  /* ---- getting the view to `ready` --------------------------------------
     A 2D MapView takes its spatial reference from, in order of precedence: an
     explicit `spatialReference`, the basemap, then the FIRST LAYER on the map.
     Until it has one it cannot resolve `zoom` into a scale, creates no layer
     views, and never reaches `ready` — so `view.when()` never settles and the
     modal reports "the map could not start" while every layer still says
     "pending". Normally the imagery layer buildView added supplies it.

     If the ImageServer is unreachable that source never arrives, so rather than
     leave the operator with a dead modal the projection is named outright on a
     second attempt. It costs nothing at that point: the base image is already
     gone, and the thematic layers are dynamic MapImageLayers, which the ArcGIS
     servers reproject server-side on export. */
  async function readyView(view, imageryDone) {
    // The wait ends at whichever comes first: the view coming up, the imagery
    // giving up entirely (nothing else is going to hand this view a projection,
    // so there is no point sitting out the rest of the bound), or the bound.
    let imagerySaidSo = false;
    const lostProjection = Promise.resolve(imageryDone).then((layer) => {
      if (layer) return new Promise(() => {});
      imagerySaidSo = true;   // loadImagery has already put a banner up
      throw new Error("the aerial imagery did not load, so nothing supplied the map's projection");
    });
    try {
      await withTimeout(Promise.race([view.when(), lostProjection]), CFG.timeouts.viewReady, "Map view");
      if (view.ready) { dlog("Map view ready."); return view; }
      throw new Error("the map view has not come up");
    } catch (err) {
      if (view.ready) { dlog("Map view ready."); return view; }
      if (view.destroyed) throw err;
      dlog(`The map view has no projection yet (${err.message}). Naming Web Mercator outright and trying once more.`);
      try { view.spatialReference = new M.esri.SpatialReference({ wkid: CFG.fallbackWkid }); } catch (_) {}
      await withTimeout(view.when(), CFG.timeouts.view, "Map view (without the aerial imagery)");
      dlog(`Map view ready on Web Mercator (wkid ${CFG.fallbackWkid}).`);
      // Don't say it twice: when the imagery reported its own failure it has
      // already told the operator the base picture is missing.
      if (!imagerySaidSo) banner("The map opened without a base picture — the aerial imagery did not supply the map projection in time. The station pin and the layers still draw.", "warn");
      return view;
    }
  }

  /* ---- the station pin --------------------------------------------------
     The one thing on this map that is not negotiable. It is a Graphic in
     view.graphics, so it sits above every layer, is captured by
     takeScreenshot, and cannot be hidden by a layer toggle. */
  function drawPin() {
    const view = M.view;
    if (!view || !M.site) return;
    view.graphics.removeAll();
    M.probeGraphic = null;   // removeAll took it with the old pin
    const label = M.site.station_num ? `${M.site.name} (${M.site.station_num})` : M.site.name;
    const g = new M.esri.Graphic({
      geometry: { type: "point", longitude: +M.site.lon, latitude: +M.site.lat },
      symbol: {
        type: "simple-marker", style: "circle", color: CFG.pinColour, size: 16,
        outline: { color: [255, 255, 255], width: 2.5 },
      },
      attributes: { label, coord: fmtCoord(M.site.lat, M.site.lon) },
      popupTemplate: { title: "{label}", content: "{coord}" },
    });
    view.graphics.add(g);
    M.pinGraphic = g;
    dlog(`Station pin drawn at ${fmtCoord(M.site.lat, M.site.lon)}.`);
  }

  // Is the pin actually inside what the capture will grab? Recorded with every
  // capture as provenance and printed in the diagnostics, so it has to be right
  // — but it is deliberately NOT used to warn the operator off a capture (see
  // captureVisible): every version of this test has been wrong often enough
  // that the warning cried wolf on perfectly well-framed maps.
  //
  // Ask the VIEW where the pin lands on screen rather than comparing geometry
  // against view.extent. The extent is in the service's spatial reference (a
  // projected CRS in metres — Web Mercator in practice), so an extent.contains()
  // against a lat/lon point is a units mismatch that reads "outside" almost
  // regardless of where the pin is; reprojecting first only moves the problem to
  // whether the projection engine happens to be loaded and whether the plain
  // object autocast to a real geometry. view.toScreen() does the view's own
  // transform, in pixels, with no projection engine and no assumption about the
  // map's CRS. The pin graphic's geometry is used because Graphic autocast it
  // into a genuine Point when the pin was drawn.
  function pinInView() {
    const view = M.view;
    if (!view || !M.site) return true;
    try {
      const geom = M.pinGraphic && M.pinGraphic.geometry;
      if (!geom || !view.ready || !(view.width > 0) || !(view.height > 0)) return true;
      const s = view.toScreen(geom);
      if (!s || !isFinite(s.x) || !isFinite(s.y)) return true;
      return s.x >= 0 && s.y >= 0 && s.x <= view.width && s.y <= view.height;
    } catch (_) { return true; }
  }

  async function whenDisplayed(view) {
    if (!view || !M.esri) return;
    if (view.ready && view.width > 0 && view.height > 0) return;
    await Promise.race([
      M.esri.reactiveUtils.whenOnce(() => view.ready && view.width > 0 && view.height > 0),
      new Promise((r) => setTimeout(r, CFG.timeouts.view)),
    ]).catch(() => {});
  }

  // Re-centre on the station unless the operator has taken manual control.
  async function fitView(force) {
    const view = M.view;
    if (!view || (!force && M.userFramed)) return;
    await whenDisplayed(view);
    try {
      await view.goTo({ target: { type: "point", longitude: +M.site.lon, latitude: +M.site.lat }, zoom: CFG.anchorZoom }, { animate: false });
    } catch (_) {
      // A goTo issued as the modal un-hides can be interrupted by the re-show
      // resize; wait for the view to settle and frame once more.
      try {
        await Promise.race([
          M.esri.reactiveUtils.whenOnce(() => view.stationary),
          new Promise((r) => setTimeout(r, 2500)),
        ]);
        await view.goTo({ target: { type: "point", longitude: +M.site.lon, latitude: +M.site.lat }, zoom: CFG.anchorZoom }, { animate: false });
      } catch (_e) { /* a stale frame beats a thrown open */ }
    }
    invalidateShot();
  }

  /* ---- build the view once ---------------------------------------------
     Constructed AT the station coordinate so the framing never depends on an
     async step completing, the loading overlay clears on view.when() and
     nothing else, then the layers stream in underneath. None of them block the
     already-open modal.

     THE ORDER HERE IS LOAD-BEARING: the imagery layer goes on the map BEFORE
     the MapView is constructed, because that layer is where the view gets its
     spatial reference (readyView explains what happens without one — it is the
     difference between this modal opening and it timing out). There is no Esri
     basemap to lean on instead; those need an API key. This is the same
     ordering the SoRT site map uses. */
  async function buildView(container) {
    const E = M.esri;
    const map = new E.Map();
    M.esriMap = map;
    M.svcLayers = {};

    // On the map before the view exists. Its load outcome is reported below.
    const imagery = newImageryLayer(E.ImageryTileLayer);
    map.add(imagery);

    const view = new E.MapView({
      container, map,
      center: [+M.site.lon, +M.site.lat],
      zoom: CFG.anchorZoom,
      popup: { dockEnabled: false, collapseEnabled: false },
      constraints: { rotationEnabled: false },
    });
    M.view = view;
    dlog(`Constructing the map view at the station coordinate ${fmtCoord(M.site.lat, M.site.lon)} (zoom ${CFG.anchorZoom}).`);
    // Started, not awaited: the view needs only the layer's PROJECTION to come
    // alive, so the modal must not sit behind a whole base image before it
    // opens. readyView is handed the promise so it can stop waiting early if
    // the imagery gives up.
    const imageryDone = loadImagery(map, imagery);
    await readyView(view, imageryDone);

    hideStatus();
    setProgress(0.3, "Drawing layers…");
    try { view.ui.move("zoom", "bottom-right"); } catch (_) {}
    try { view.ui.add(new E.ScaleBar({ view, unit: "metric" }), "bottom-left"); } catch (_) {}

    // A real user pan/zoom latches manual framing (so re-opening no longer
    // snaps back) and invalidates the cached capture. Watch `interacting`,
    // which is true only on genuine input — not `navigating`, which our own
    // goTo also sets.
    E.reactiveUtils.when(() => view.interacting, () => {
      if (!M.userFramed) { M.userFramed = true; renderPanel(); }
      invalidateShot();
    });
    E.reactiveUtils.watch(() => view.stationary, (s) => { if (s) { invalidateShot(); updateScaleHint(); repositionProbe(); renderDiagnostics(); } });
    E.reactiveUtils.watch(() => view.updating, (u) => { if (!u) settleProgress(); });
    E.reactiveUtils.watch(() => view.scale, updateScaleHint);

    // A click asks every ticked service what covers that point (runProbe). The
    // BUILT-IN popup is switched off first: leaving it on means two popups
    // fighting over the same click, and the station pin's own bubble opening
    // over the answer the operator actually asked for.
    view.popupEnabled = false;
    view.on("click", (e) => {
      if (!e || !e.mapPoint) return;
      runProbe(e.mapPoint, { x: e.x, y: e.y }).catch((err) => dlog(`Identify failed: ${err && err.message}`));
    });

    // The imagery is left to finish in the background: it reports its own
    // outcome, and insertOrdered keys off z-order rather than arrival order, so
    // it slides under everything else whenever it lands. The thematic layers
    // must not queue behind a slow base image.
    setProgress(0.45, "Drawing layers…");
    return view;
  }

  // (Re)draw every service layer for the current selection. Called on open and
  // whenever a tick changes a service that isn't on the map yet.
  async function syncLayers() {
    const map = M.esriMap;
    if (!map || !M.esri) return;
    M.building = true;
    setProgress(0.5, "Resolving layers…");
    await resolveSelected();
    renderPanel();
    setProgress(0.65, "Drawing layers…");

    const svcKeys = [...new Set(Object.keys(LAYER_INDEX)
      .filter((id) => M.selection.has(id))
      .map((id) => LAYER_INDEX[id].layer.svc))];

    // Existing layers: flip sublayer visibility in place (no reload).
    for (const [key, layer] of Object.entries(M.svcLayers)) {
      if (!layer) continue;
      const subs = serviceSublayers(key);
      const whole = wholeService(key);
      // A whole-service layer has no per-sublayer state to flip: it is either
      // on the map or it is not. Treating it like the others would compute an
      // empty visible-set and switch the labels off the moment anything synced.
      if (whole && !subs.length) { layer.visible = true; continue; }
      const known = new Set(subs.map((s) => s.id));
      const wantVisible = new Set(subs.filter((s) => s.visible).map((s) => s.id));
      // Every sublayer this service resolved is already ON the layer object
      // (built visible or not), so a tick usually costs one visibility flip.
      // A sublayer the layer was never built with means a newly-ticked layer
      // that resolved after the layer was created — only then is a rebuild
      // needed. Only ids we put there are ever touched, so a group parent we
      // did not create can never be switched off underneath its children.
      const allPresent = subs.every((s) => layer.findSublayerById && layer.findSublayerById(s.id));
      if (allPresent) {
        layer.allSublayers.forEach((sl) => { if (known.has(sl.id)) sl.visible = wantVisible.has(sl.id); });
        layer.visible = wantVisible.size > 0;
      } else {
        // A newly-ticked sublayer this layer was never built with — rebuild it.
        try { map.remove(layer); } catch (_) {}
        delete M.svcLayers[key];
        await buildServiceLayer(map, key);
      }
    }
    // Services not on the map yet.
    await Promise.all(svcKeys.filter((k) => !M.svcLayers[k]).map((k) => buildServiceLayer(map, k)));

    M.building = false;
    renderPanel();
    renderFurniture();
    invalidateShot();
    setProgress(1, "Map ready");
    // Started, never awaited: the symbology is for the click popup and the
    // report appendix, and the map must not wait on it to finish drawing.
    ensureLegends().then(() => { if (M.probe) renderProbe(); }).catch(() => {});
  }

  // ------------------------------------------------------------------ chrome
  function banner(msg, kind) {
    const host = M.hosts.banners;
    if (!host) return;
    const b = el("div", { class: `qm-banner qm-banner--${kind || "warn"}` },
      el("span", {}, msg),
      el("button", { type: "button", class: "qm-banner-x", "aria-label": "Dismiss", onclick: (e) => e.target.closest(".qm-banner").remove() }, "✕"));
    host.append(b);
  }
  function clearBanners() { if (M.hosts.banners) M.hosts.banners.innerHTML = ""; }
  function hideStatus() { if (M.hosts.status) M.hosts.status.hidden = true; }
  function showStatus(html) {
    if (!M.hosts.status) return;
    M.hosts.status.hidden = false;
    M.hosts.status.innerHTML = html;
  }
  function setProgress(v, note) {
    const host = M.hosts.progress, bar = M.hosts.progressBar, n = M.hosts.progressNote;
    if (!host || !bar) return;
    host.hidden = false;
    host.classList.add("on");
    const pct = Math.round(Math.max(0, Math.min(1, v)) * 100);
    bar.style.width = `${pct}%`;
    host.setAttribute("aria-valuenow", String(pct));
    if (n && note) n.textContent = note;
    if (v >= 1) setTimeout(() => { host.classList.remove("on"); setTimeout(() => { if (!host.classList.contains("on")) host.hidden = true; }, 350); }, 500);
  }
  // Only completes when the view AND every layer view have stopped drawing —
  // `view.updating` alone flips false in the gap before a layer starts fetching.
  function settleProgress() {
    const view = M.view;
    if (!view || M.building) return;
    try {
      if (view.allLayerViews && view.allLayerViews.toArray().some((lv) => lv.updating)) return;
    } catch (_) {}
    setProgress(1, "Map ready");
  }
  function updateScaleHint() {
    const host = M.hosts.scaleHint, view = M.view;
    if (!host || !view) return;
    const s = view.scale || 0;
    const hidden = [];
    if (s > CFG.thematicMinScale) hidden.push("environmental layers");
    if (s > CFG.detailMinScale) hidden.push("cadastre and contours");
    if (hidden.length && [...M.selection].length) {
      host.hidden = false;
      host.textContent = `Zoom in to see ${hidden.join(" and ")} — they are hidden at this scale.`;
    } else { host.hidden = true; }
    renderFurniture();
  }

  /* ---- on-map furniture --------------------------------------------------
     Drawn ON the map at the same corners `composite()` draws them into the
     exported PNG, so the map area on screen IS a preview of the picture. The
     LAYER LIST is deliberately NOT here: with forty-odd layers it would bury
     the map. It travels to the report appendix instead. */
  function renderFurniture() {
    const L = M.hosts.furnitureL, R = M.hosts.furnitureR;
    if (!L || !R || !M.site) return;
    // No view = no picture to preview, so the furniture would just be floating
    // labels over an error message. Hide it until there is a map under it.
    const live = !!M.view;
    L.hidden = !live; R.hidden = !live;
    if (!live) return;
    L.innerHTML = "";
    L.append(
      el("div", { class: "qm-fl-title" }, M.site.station_num ? `${M.site.name} (${M.site.station_num})` : M.site.name),
      el("div", { class: "qm-fl-coord" }, fmtCoord(M.site.lat, M.site.lon)));
    const n = activeLayerRows().length;
    R.textContent = `${n} layer${n === 1 ? "" : "s"}${M.view && M.view.scale ? ` · 1:${Math.round(M.view.scale).toLocaleString()}` : ""}`;
  }

  // The layers actually contributing to the picture: ticked AND resolved. This
  // is what the appendix cites — never the raw tick list, which could include a
  // layer that was withheld. Each row carries the service's OWN legend swatches
  // (capped — see CFG.legendMaxPerLayer) so the report can print a legend box
  // per layer and the picture stays readable once it leaves this screen.
  function activeLayerRows() {
    const rows = [];
    LAYER_GROUPS.forEach((g) => g.layers.forEach((l) => {
      if (!M.selection.has(l.id)) return;
      const r = M.resolved[l.id];
      if (!r || r.status !== "ok") return;
      const all = legendEntries(l.id);
      rows.push({
        id: l.id, name: l.name, group: g.title, colour: g.colour,
        service: SERVICES[l.svc].label, url: SERVICES[l.svc].url, sublayer: r.sublayer, via: r.via,
        legend: all.slice(0, CFG.legendMaxPerLayer).map((e) => ({ label: e.label, swatch: e.swatch })),
        legendMore: Math.max(0, all.length - CFG.legendMaxPerLayer),
      });
    }));
    return rows;
  }

  /* ---- "what is at this point?" -----------------------------------------
     Forty translucent layers stack on one map, and the panel's group colours
     are OURS, not the services' — so a shaded patch cannot be read back to a
     layer by eye, which is the whole problem this answers. A click asks the
     services themselves: one `identify` call per MapServer, restricted to the
     sublayers actually ticked, and every layer covering that point is named in
     a popup beside the service's own legend swatch.

     One call per SERVICE, not per layer — the same reason the map draws one
     MapImageLayer per service: forty round-trips per click would be unusable.
     Each call is bounded and reports itself, and a service that fails is NAMED
     in the popup rather than dropped, because "nothing is here" and "we could
     not ask" are very different answers to give an assessor. */

  // Label-only services have nothing to say about what is at a point.
  const IDENTIFY_SKIP = new Set(["labels"]);
  // Housekeeping columns every ArcGIS table carries; they tell the operator
  // nothing and would push the real attributes out of the popup.
  const ATTR_SKIP = /^(objectid|fid|globalid|shape|shape[._ ]|st_area|st_length|se_anno|created_|last_edit|editor_|esri)/i;
  // Only the server's own placeholders for "no value" — deliberately NOT "0" or
  // "None", which are real answers to questions like a buffer width or a
  // protection status, and hiding them would misreport the site.
  const ATTR_EMPTY = /^(null|<null>|<all other values>)$/i;

  // The resolved sublayer ids of one service that are currently ticked.
  function identifiableSublayers(key) {
    const ids = [];
    for (const id of Object.keys(LAYER_INDEX)) {
      const { layer } = LAYER_INDEX[id];
      if (layer.svc !== key || layer.whole || !M.selection.has(id)) continue;
      const r = M.resolved[id];
      if (!r || r.status !== "ok" || r.sublayer == null) continue;
      if (!ids.includes(r.sublayer)) ids.push(r.sublayer);
    }
    return ids;
  }

  // Which catalogue entry a returned sublayer id belongs to. One sublayer can
  // back two catalogue entries; the ticked one is the one the operator means.
  function catalogueEntryFor(svcKey, sublayerId) {
    for (const id of Object.keys(LAYER_INDEX)) {
      const { layer, group } = LAYER_INDEX[id];
      if (layer.svc !== svcKey || !M.selection.has(id)) continue;
      const r = M.resolved[id];
      if (r && r.status === "ok" && r.sublayer === sublayerId) return { id, layer, group };
    }
    return null;
  }

  // `returnFieldName=false` means the server hands back field ALIASES, which
  // are already human-readable — so this only has to drop the housekeeping and
  // the empties, and stop before the popup turns into a database dump.
  function tidyAttributes(attrs) {
    const out = [];
    if (!attrs || typeof attrs !== "object") return out;
    for (const [k, v] of Object.entries(attrs)) {
      if (out.length >= CFG.identifyMaxAttrs) break;
      if (ATTR_SKIP.test(k)) continue;
      const val = v == null ? "" : String(v).trim();
      if (!val || ATTR_EMPTY.test(val)) continue;
      out.push({ k: String(k).trim(), v: val });
    }
    return out;
  }
  const cleanValue = (v) => {
    const s = v == null ? "" : String(v).trim();
    return ATTR_EMPTY.test(s) ? "" : s;
  };

  // One service's answer. Never throws: a failure becomes `error`, which the
  // popup shows as "could not ask this service".
  async function identifyService(key, point, wkid, extent, size) {
    const svc = SERVICES[key];
    const ids = identifiableSublayers(key);
    if (!ids.length) return { key, rows: [], error: null };
    const params = new URLSearchParams({
      f: "json",
      geometry: JSON.stringify({ x: point.x, y: point.y, spatialReference: { wkid } }),
      geometryType: "esriGeometryPoint",
      sr: String(wkid),
      // `all:` rather than `visible:` — a layer suppressed by the zoom scale is
      // still ticked, and the operator asking what is here deserves the answer.
      layers: `all:${ids.join(",")}`,
      tolerance: String(CFG.identifyTolerance),
      mapExtent: `${extent.xmin},${extent.ymin},${extent.xmax},${extent.ymax}`,
      imageDisplay: `${Math.round(size.w) || 800},${Math.round(size.h) || 600},96`,
      returnGeometry: "false",
      returnFieldName: "false",
    });
    try {
      const { json } = await fetchJson(`${svc.url}/identify?${params.toString()}`, `${svc.label} identify`, CFG.timeouts.identify);
      if (json && json.error) throw new Error(json.error.message || "the service refused the request");
      const rows = (json.results || []).map((res) => {
        const hit = catalogueEntryFor(key, res.layerId);
        return {
          service: svc.label,
          name: hit ? hit.layer.name : String(res.layerName || `Sublayer ${res.layerId}`),
          groupTitle: hit ? hit.group.title : svc.label,
          colour: hit ? hit.group.colour : "#546e7a",
          value: cleanValue(res.value),
          attrs: tidyAttributes(res.attributes),
          swatch: hit ? swatchForFeature(hit.id, res) : null,
        };
      });
      return { key, rows, error: null };
    } catch (e) {
      return { key, rows: [], error: e.message || "the request failed" };
    }
  }

  // The ring marking the asked-about point. It lives in view.graphics, so it
  // WOULD be captured — closeProbe() runs before every screenshot.
  function drawProbeMarker(point) {
    clearProbeMarker();
    if (!M.view || !M.esri) return;
    try {
      const g = new M.esri.Graphic({
        geometry: point,
        symbol: { type: "simple-marker", style: "circle", size: 15, color: [255, 255, 255, 0.18],
          outline: { color: [17, 24, 39], width: 2 } },
      });
      M.view.graphics.add(g);
      M.probeGraphic = g;
    } catch (_) {}
  }
  function clearProbeMarker() {
    if (M.probeGraphic && M.view) { try { M.view.graphics.remove(M.probeGraphic); } catch (_) {} }
    M.probeGraphic = null;
  }
  function closeProbe() {
    M.probeToken++;      // any answer still in flight is now stale
    M.probe = null;
    clearProbeMarker();
    renderProbe();
  }

  // Was the click on the station pin? Measured in screen pixels via the view's
  // own transform, for the same reason pinInView() does (no projection engine,
  // no assumption about the map's CRS).
  function clickedThePin(screen) {
    try {
      const geom = M.pinGraphic && M.pinGraphic.geometry;
      if (!geom || !M.view || !screen) return false;
      const s = M.view.toScreen(geom);
      if (!s || !isFinite(s.x) || !isFinite(s.y)) return false;
      return Math.hypot(s.x - screen.x, s.y - screen.y) <= 16;
    } catch (_) { return false; }
  }

  async function runProbe(mapPoint, screen) {
    const view = M.view;
    if (!view || !view.ready || !mapPoint) return;
    const token = ++M.probeToken;
    const sr = view.spatialReference || {};
    const wkid = sr.wkid || sr.latestWkid || CFG.fallbackWkid;
    const extent = view.extent;
    if (!extent) return;
    const keys = Object.keys(SERVICES).filter((k) => !IDENTIFY_SKIP.has(k) && identifiableSublayers(k).length);
    const lat = typeof mapPoint.latitude === "number" ? mapPoint.latitude : null;
    const lon = typeof mapPoint.longitude === "number" ? mapPoint.longitude : null;
    drawProbeMarker(mapPoint);
    M.probe = {
      token, point: mapPoint, screen,
      coord: lat != null && lon != null ? fmtCoord(lat, lon) : `${Math.round(mapPoint.x)}, ${Math.round(mapPoint.y)} (map units)`,
      onPin: clickedThePin(screen),
      asked: keys.length, pending: keys.length,
      groups: [], failures: [], done: !keys.length,
      // Layers the zoom level is currently suppressing: the answer can name a
      // layer that is not being drawn, and saying so is better than leaving the
      // operator hunting for a colour that is not on screen.
      suppressed: view.scale > CFG.thematicMinScale,
    };
    renderProbe();
    setDiag("identify", { status: "asking", services: keys.length }, `Asked ${keys.length} service${keys.length === 1 ? "" : "s"} what is at ${M.probe.coord}.`);
    if (!keys.length) return;

    await Promise.all(keys.map(async (k) => {
      const out = await identifyService(k, mapPoint, wkid, extent, { w: view.width, h: view.height });
      if (M.probeToken !== token || !M.probe) return;   // a newer click has taken over
      M.probe.pending--;
      if (out.error) M.probe.failures.push({ service: SERVICES[k].label, note: out.error });
      out.rows.forEach((row) => addProbeRow(row));
      renderProbe();
    }));
    if (M.probeToken !== token || !M.probe) return;
    M.probe.done = true;
    const found = M.probe.groups.reduce((n, g) => n + g.rows.length, 0);
    setDiag("identify", { status: "done", found, failed: M.probe.failures.length },
      `${found} feature${found === 1 ? "" : "s"} reported at that point${M.probe.failures.length ? `; ${M.probe.failures.length} service(s) could not be asked` : ""}.`);
    renderProbe();
  }

  // Group the answers the way the panel groups the catalogue, so the popup and
  // the layer list read the same way round. Identical repeats of one feature
  // (a service can return the same polygon twice) are collapsed.
  function addProbeRow(row) {
    const p = M.probe;
    if (!p) return;
    let g = p.groups.find((x) => x.title === row.groupTitle);
    if (!g) { g = { title: row.groupTitle, colour: row.colour, rows: [] }; p.groups.push(g); }
    const key = `${row.name}|${row.value}|${row.attrs.map((a) => `${a.k}=${a.v}`).join(";")}`;
    if (g.rows.some((r) => r.__key === key)) return;
    row.__key = key;
    g.rows.push(row);
  }

  function renderProbe() {
    const host = M.hosts.pop;
    if (!host) return;
    const p = M.probe;
    host.innerHTML = "";
    if (!p) { host.hidden = true; return; }
    host.hidden = false;

    host.append(el("div", { class: "qm-pop-head" },
      el("div", { class: "qm-pop-titles" },
        el("b", {}, "What is at this point"),
        el("span", { class: "qm-pop-coord" }, p.coord)),
      el("button", { type: "button", class: "qm-pop-x", "aria-label": "Close", title: "Close", onclick: closeProbe }, "✕")));

    const body = el("div", { class: "qm-pop-body" });
    if (p.onPin)
      body.append(el("div", { class: "qm-pop-pin" }, "📍 ",
        M.site.station_num ? `${M.site.name} (${M.site.station_num})` : M.site.name,
        " — the station pin is at this point."));

    const found = p.groups.reduce((n, g) => n + g.rows.length, 0);
    p.groups.forEach((g) => {
      const sec = el("div", { class: "qm-pop-group" },
        el("div", { class: "qm-pop-group-head" }, el("i", { class: "qm-swatch", style: `--sw:${g.colour}` }), g.title));
      g.rows.forEach((row) => {
        const head = el("div", { class: "qm-pop-row-head" },
          // The service's own symbol where it could be matched with certainty,
          // otherwise the panel's group colour — never a guessed swatch.
          row.swatch
            ? el("img", { class: "qm-pop-swatch", src: row.swatch, alt: "" })
            : el("i", { class: "qm-swatch qm-pop-swatch-fallback", style: `--sw:${row.colour}` }),
          el("b", {}, row.name));
        const item = el("div", { class: "qm-pop-row" }, head);
        if (row.value) item.append(el("div", { class: "qm-pop-value" }, row.value));
        if (row.attrs.length)
          item.append(el("dl", { class: "qm-pop-attrs" },
            row.attrs.flatMap((a) => [el("dt", {}, a.k), el("dd", {}, a.v)])));
        item.append(el("div", { class: "qm-pop-src" }, row.service));
        sec.append(item);
      });
      body.append(sec);
    });

    if (p.pending > 0)
      body.append(el("div", { class: "qm-pop-wait" }, el("span", { class: "qm-spin", "aria-hidden": "true" }),
        `Asking ${p.pending} of ${p.asked} service${p.asked === 1 ? "" : "s"}…`));
    else if (!found && !p.onPin)
      body.append(el("p", { class: "qm-pop-empty" }, p.asked
        ? "None of the ticked layers cover this point."
        : "No layers are ticked, so there is nothing to ask about. Tick some layers in the panel and click the map again."));

    if (found && p.suppressed)
      body.append(el("p", { class: "qm-pop-note" }, "Some of these layers are hidden at this zoom level — zoom in to see them drawn."));

    p.failures.forEach((f) =>
      body.append(el("p", { class: "qm-pop-fail" }, `⚠ ${f.service} could not be asked (${f.note}) — it may still cover this point.`)));

    // Counted as FEATURES and LAYERS separately: one layer can return several
    // overlapping polygons at a point, so "n of the m layers" was able to
    // report more layers than the map has.
    if (p.done && (found || p.failures.length)) {
      const names = new Set();
      p.groups.forEach((g) => g.rows.forEach((r) => names.add(r.name)));
      body.append(el("p", { class: "qm-pop-foot" },
        `${found} feature${found === 1 ? "" : "s"} from ${names.size} layer${names.size === 1 ? "" : "s"} · ${activeLayerRows().length} layers on the map.`));
    }

    host.append(body);
    positionProbe();
  }

  // Placed beside the click and clamped inside the map, so the popup can never
  // open half off-screen or under the panel.
  function positionProbe() {
    const host = M.hosts.pop, mapEl = M.hosts.map, p = M.probe;
    if (!host || !mapEl || !p || !p.screen) return;
    const mw = mapEl.clientWidth, mh = mapEl.clientHeight;
    const w = host.offsetWidth || 330, h = host.offsetHeight || 220;
    const pad = 10, gap = 16;
    let left = p.screen.x + gap;
    if (left + w + pad > mw) left = p.screen.x - w - gap;
    host.style.left = `${Math.round(Math.max(pad, Math.min(left, Math.max(pad, mw - w - pad))))}px`;
    host.style.top = `${Math.round(Math.max(pad, Math.min(p.screen.y - Math.round(h / 3), Math.max(pad, mh - h - pad))))}px`;
  }

  // Keep the popup with its point as the map moves, rather than leaving it
  // pointing at wherever that patch of screen now happens to be.
  function repositionProbe() {
    const p = M.probe;
    if (!p || !M.view || !p.point) return;
    try {
      const s = M.view.toScreen(p.point);
      if (s && isFinite(s.x) && isFinite(s.y)) { p.screen = { x: s.x, y: s.y }; positionProbe(); }
    } catch (_) {}
  }

  // ------------------------------------------------------------------- panel
  function renderPanel() {
    const host = M.hosts.layerList;
    if (!host) return;
    const q = (M.hosts.search && M.hosts.search.value.trim().toLowerCase()) || "";
    host.innerHTML = "";
    let shown = 0;
    LAYER_GROUPS.forEach((g) => {
      const matches = g.layers.filter((l) => !q || l.name.toLowerCase().includes(q) || g.title.toLowerCase().includes(q));
      if (!matches.length) return;
      const onCount = matches.filter((l) => M.selection.has(l.id)).length;
      const sec = el("section", { class: "qm-group" });
      const head = el("div", { class: "qm-group-head" },
        el("i", { class: "qm-swatch", style: `--sw:${g.colour}` }),
        el("b", {}, g.title),
        el("span", { class: "qm-group-count" }, `${onCount}/${matches.length}`),
        el("button", {
          type: "button", class: "qm-group-toggle",
          title: onCount === matches.length ? "Turn every layer in this group off" : "Turn every layer in this group on",
          onclick: () => {
            const turnOn = onCount < matches.length;
            matches.forEach((l) => { if (turnOn) M.selection.add(l.id); else M.selection.delete(l.id); });
            selectionChanged();
          },
        }, onCount === matches.length ? "None" : "All"));
      sec.append(head);
      if (g.note) sec.append(el("p", { class: "qm-group-note" }, g.note));
      matches.forEach((l) => {
        const r = M.resolved[l.id];
        const cb = el("input", { type: "checkbox" });
        cb.checked = M.selection.has(l.id);
        cb.addEventListener("change", () => {
          if (cb.checked) M.selection.add(l.id); else M.selection.delete(l.id);
          selectionChanged();
        });
        let stateNote = null;
        if (M.selection.has(l.id) && r) {
          if (r.status === "not-found") stateNote = el("span", { class: "qm-lstate qm-lstate--miss", title: r.note }, "not on service");
          else if (r.status === "service-failed") stateNote = el("span", { class: "qm-lstate qm-lstate--miss", title: r.note }, "service unavailable");
          else if (r.status === "ok" && /fallback/.test(r.via || "")) stateNote = el("span", { class: "qm-lstate qm-lstate--guess", title: r.via }, "id fallback");
        }
        sec.append(el("label", { class: "qm-layer" + (stateNote && !/guess/.test(stateNote.className) ? " is-miss" : "") },
          cb, el("i", { class: "qm-swatch", style: `--sw:${g.colour}` }),
          el("span", { class: "qm-layer-name" }, l.name), stateNote));
        shown++;
      });
      host.append(sec);
    });
    if (!shown) host.append(el("p", { class: "qm-empty" }, "No layers match that search."));
    const sum = M.hosts.layerSummary;
    if (sum) {
      const active = activeLayerRows().length, ticked = M.selection.size;
      // Three genuinely different states, and saying the wrong one sends the
      // operator hunting a layer problem that is really a dead map: nothing has
      // been ATTEMPTED yet (no map), everything drew, or some were withheld.
      const attempted = Object.keys(M.resolved).length > 0;
      sum.textContent = !attempted ? `${ticked} layer${ticked === 1 ? "" : "s"} selected`
        : active === ticked ? `${active} layer${active === 1 ? "" : "s"} on the map`
          : `${active} of ${ticked} drawing — the rest could not be resolved`;
    }
    const rv = M.hosts.resetView;
    if (rv) rv.classList.toggle("is-active", M.userFramed);
    renderFurniture();
  }

  // Debounced so dragging through a group's checkboxes doesn't fire a rebuild
  // per tick. Persistence is told immediately; the map catches up.
  let syncTimer = null;
  function selectionChanged() {
    renderPanel();
    if (M.hooks.onChange) { try { M.hooks.onChange([...M.selection]); } catch (_) {} }
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { syncLayers().catch(() => {}); }, 250);
  }

  // ------------------------------------------------------------------ capture
  function invalidateShot() {
    M.shot.valid = false;
    M.shot.dataUrl = null;
    renderCaptureCard();
  }

  // Wait until the view is genuinely ready to be captured. A SUSPENDED view
  // (container display:none) reports `updating === false` because it has simply
  // STOPPED — so a naive "not updating" gate resolves instantly and captures an
  // empty frame. Each leg is bounded so nothing can hang the capture.
  async function whenCaptureReady(view) {
    if (!view || !M.esri) return;
    const E = M.esri, budget = CFG.timeouts.layer;
    const settle = (pred) => Promise.race([
      E.reactiveUtils.whenOnce(pred),
      new Promise((r) => setTimeout(r, budget)),
    ]).catch(() => {});
    await settle(() => !view.suspended && view.ready && view.width > 0 && view.height > 0);
    await new Promise((r) => setTimeout(r, 80)); // let a just-resumed view restart drawing
    await settle(() => !view.updating && (!view.allLayerViews || view.allLayerViews.toArray().every((lv) => !lv.updating)));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  // Probe the RAW captured raster before any base fill. The failure that matters
  // is a mostly-TRANSPARENT frame — a suspended view draws nothing but the
  // in-memory vector pin — which a white fill would then turn into a plausible
  // pale "map". Measure coverage (fraction of non-transparent samples) and how
  // many coarse colour buckets appear: real aerial imagery spreads across
  // hundreds, a pin-only frame has a handful.
  function rasterStats(ctx, W, H) {
    try {
      const data = ctx.getImageData(0, 0, W, H).data;
      const N = 48;
      let covered = 0, total = 0;
      const buckets = new Set();
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const x = Math.min(W - 1, Math.floor(((i + 0.5) * W) / N));
          const y = Math.min(H - 1, Math.floor(((j + 0.5) * H) / N));
          const o = (y * W + x) * 4;
          total++;
          if (data[o + 3] > 8) { covered++; buckets.add(`${data[o] >> 3},${data[o + 1] >> 3},${data[o + 2] >> 3}`); }
        }
      }
      return { coverage: total ? covered / total : 0, distinct: buckets.size };
    } catch (_) { return null; }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // Composite the report furniture onto the raw screenshot. Throws rather than
  // return a blank rectangle — a map that never rendered must be caught HERE,
  // in the modal with the real map next to it, not after it reaches a report.
  async function composite(shot) {
    if (!shot || !shot.dataUrl) {
      setDiag("screenshot", { status: "failed", note: "takeScreenshot returned no image" }, "The capture returned no image — not adding a blank picture.");
      throw new Error("the capture returned no image data");
    }
    const img = new Image();
    img.src = shot.dataUrl;
    let decoded = false;
    try {
      if (img.decode) { await img.decode(); decoded = true; }
      else { await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("image failed to load")); }); decoded = true; }
    } catch (_) {
      try { await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("image failed to load")); }); decoded = true; }
      catch (_e) { decoded = false; }
    }
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width || shot.width || 0;
    canvas.height = img.naturalHeight || img.height || shot.height || 0;
    const W = canvas.width, H = canvas.height;
    if (!W || !H) {
      setDiag("screenshot", { status: "failed", note: "zero-sized capture", decoded }, "The capture had no dimensions — not adding a blank picture.");
      throw new Error("the capture had no dimensions");
    }
    const ctx = canvas.getContext("2d");
    if (!decoded) {
      setDiag("screenshot", { status: "failed", note: "raster did not decode", dims: `${W}×${H}` }, "The captured image did not decode — not adding a blank picture.");
      throw new Error("the captured image did not decode");
    }
    // Draw the raw frame on a still-transparent canvas so the stats measure the
    // capture's TRUE alpha coverage before any fill paints over it.
    ctx.drawImage(img, 0, 0, W, H);
    const suspended = !!(M.view && M.view.suspended);
    const stats = rasterStats(ctx, W, H);
    if (stats && (stats.coverage < 0.5 || stats.distinct <= 4)) {
      const pct = Math.round(stats.coverage * 100);
      setDiag("screenshot", { status: "failed", dims: `${W}×${H}`, coverage: stats.coverage, distinct: stats.distinct, suspended, note: `raster nearly empty (~${pct}% covered, ${stats.distinct} distinct colours)` },
        `The captured frame was nearly empty (~${pct}% covered, ${stats.distinct} colours)${suspended ? " because the map view was suspended" : ""} — not adding a blank picture.`);
      throw new Error("the map had not finished drawing — the picture came out blank");
    }
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
    setDiag("screenshot", { status: "ok", dims: `${W}×${H}`, coverage: stats ? stats.coverage : null, distinct: stats ? stats.distinct : null, suspended },
      `Map picture captured (${W}×${H}${stats ? `, ~${Math.round(stats.coverage * 100)}% covered` : ""}).`);

    const pad = Math.round(W * 0.012);
    const fs = Math.max(13, Math.round(W * 0.0135));
    ctx.textBaseline = "top";

    // Top-left: the site and its coordinate — a report map must say where it is
    // even when it is separated from its caption.
    const title = M.site.station_num ? `${M.site.name} (${M.site.station_num})` : M.site.name;
    const coord = fmtCoord(M.site.lat, M.site.lon);
    ctx.font = `bold ${fs}px Segoe UI, Arial, sans-serif`;
    const tw = ctx.measureText(title).width;
    ctx.font = `${Math.max(11, Math.round(fs * 0.86))}px Segoe UI, Arial, sans-serif`;
    const cw = ctx.measureText(coord).width;
    const boxW = Math.max(tw, cw) + pad * 2;
    const boxH = fs + Math.round(fs * 0.86) + pad * 1.6;
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    roundRect(ctx, pad, pad, boxW, boxH, 6); ctx.fill();
    ctx.fillStyle = "#13293d";
    ctx.font = `bold ${fs}px Segoe UI, Arial, sans-serif`;
    ctx.fillText(title, pad * 2, pad * 1.5);
    ctx.fillStyle = "#3a4a56";
    ctx.font = `${Math.max(11, Math.round(fs * 0.86))}px Segoe UI, Arial, sans-serif`;
    ctx.fillText(coord, pad * 2, pad * 1.5 + fs + 3);

    // Top-right: layer count + scale. The NAMES go to the report appendix — a
    // legend of forty layers would cover the map it is meant to explain.
    const rows = activeLayerRows();
    const stamp = `${rows.length} layer${rows.length === 1 ? "" : "s"}${M.view && M.view.scale ? ` · 1:${Math.round(M.view.scale).toLocaleString()}` : ""}`;
    ctx.font = `${fs}px Segoe UI, Arial, sans-serif`;
    const sw = ctx.measureText(stamp).width;
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    roundRect(ctx, W - sw - pad * 2.6, pad, sw + pad * 1.6, fs + pad, 6); ctx.fill();
    ctx.fillStyle = "#13293d";
    ctx.fillText(stamp, W - sw - pad * 1.8, pad + pad * 0.3);

    // Bottom band: attribution and the pointer to the appendix.
    const band = fs + pad;
    ctx.fillStyle = "rgba(0,0,0,0.58)";
    ctx.fillRect(0, H - band, W, band);
    ctx.fillStyle = "#ffffff";
    ctx.font = `${Math.max(11, Math.round(fs * 0.85))}px Segoe UI, Arial, sans-serif`;
    ctx.fillText(`${CFG.attribution} · layers listed in the report appendix`, pad, H - band + pad * 0.4);

    return canvas.toDataURL("image/jpeg", 0.9);
  }

  // One press does the whole job: take the picture AND put it in the report.
  // Capture and add used to be two buttons, which mostly produced captures that
  // were never added — the second press decided nothing, so it is no longer
  // asked for. The thumbnail below is the receipt, and pressing again replaces
  // the picture already in the report.
  async function captureForReport(btn) {
    // The appendix's legend boxes are only as good as the symbology we have
    // read, so give the outstanding /legend calls their bounded moment before
    // the picture is recorded. Bounded, and a failure is not fatal: a layer
    // without a swatch still reaches the appendix by name.
    await Promise.race([ensureLegends(), new Promise((r) => setTimeout(r, CFG.timeouts.legend))]).catch(() => {});
    const dataUrl = await captureVisible(btn);
    if (!dataUrl) return null;
    addToReport(btn);
    return dataUrl;
  }

  // Deliberately renders no message on success: its caller adds the picture to
  // the report straight afterwards and says so, and a "captured, now press…"
  // line in between would describe a step that no longer exists.
  async function captureVisible(btn) {
    if (!M.view) { renderCaptureCard("The map hasn't loaded yet — wait for it to appear, then press the button again.", "err"); return null; }
    const restore = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = "Capturing…"; }
    renderCaptureCard("Waiting for the map to finish drawing…");
    // The "what is here?" ring is a Graphic, so takeScreenshot would put it in
    // the report. Take it off the map (and close its popup) first, so the
    // picture is the map — not the map plus the last thing that was clicked.
    closeProbe();
    try {
      await whenCaptureReady(M.view);
      // Recorded as provenance only. It is NOT turned into a warning: the check
      // has a long history of calling a well-framed map "outside", and a false
      // alarm on every capture teaches the operator to ignore the card.
      const inView = pinInView();
      const shot = await M.view.takeScreenshot();
      const dataUrl = await composite(shot);
      M.shot = {
        dataUrl, valid: true, at: Date.now(),
        meta: {
          lat: M.site.lat, lon: M.site.lon,
          scale: M.view.scale ? Math.round(M.view.scale) : null,
          pinInView: inView,
          layerCount: activeLayerRows().length,
        },
      };
      renderDiagnostics();
      return dataUrl;
    } catch (err) {
      const why = (err && err.message) || "the capture failed";
      renderCaptureCard(/blank|nearly empty|no image|did not decode|no dimensions/i.test(why)
        ? "The map hadn't finished drawing, so the picture came out blank — nothing was captured. Wait for the bar at the bottom of the map to finish, then try again."
        : `Couldn't capture the map (${why}). Open Map diagnostics below for the detail.`, "err");
      renderDiagnostics();
      return null;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = restore; }
    }
  }

  function renderCaptureCard(msg, kind) {
    const card = M.hosts.captureCard;
    if (!card) return;
    const stateEl = card.querySelector(".qm-cap-state");
    const thumb = card.querySelector(".qm-cap-thumb");
    const ready = !!(M.shot.valid && M.shot.dataUrl);
    let text = msg, tone = kind || "";
    if (!text) {
      // The button captures AND adds, so "captured but not in the report" is no
      // longer a state the operator can be left sitting in — only a stale one is.
      if (ready && M.capture && M.capture.at === M.shot.at) { text = `✓ In the report — captured ${clock(M.shot.at)}.`; tone = "ok"; }
      else if (ready) { text = `✓ Captured ${clock(M.shot.at)}.`; tone = "ok"; }
      else if (M.capture) { text = `The map has moved since the picture from ${clock(M.capture.at)} that is in the report. Capture again to replace it with what you see now.`; }
      else if (M.shot.at) { text = "The map has moved since the last picture. Capture again so the report matches what you see."; tone = "warn"; }
      else { text = "Nothing captured yet."; }
    }
    if (stateEl) {
      stateEl.textContent = text;
      stateEl.className = `qm-cap-state${tone ? ` qm-cap-state--${tone}` : ""}`;
    }
    if (thumb) {
      // Falls back to the picture already in the report: panning the map
      // invalidates the pending shot, and blanking the thumbnail then reads as
      // "the report has no map" when it plainly does.
      const shown = ready ? M.shot.dataUrl : (M.capture && M.capture.dataUrl) || null;
      if (shown) { thumb.src = shown; thumb.hidden = false; }
      else { thumb.removeAttribute("src"); thumb.hidden = true; }
    }
    // The capture button's enabled state is owned by the capture itself (it
    // disables while the picture is being taken), so it is not touched here —
    // this can be called mid-capture and would switch it back on.
  }

  function addToReport(btn) {
    if (!M.shot.valid || !M.shot.dataUrl) { renderCaptureCard("Capture the map first.", "err"); return; }
    const rows = activeLayerRows();
    const record = {
      dataUrl: M.shot.dataUrl,
      caption: `Queensland Globe — ${M.site.name}${M.site.station_num ? ` (${M.site.station_num})` : ""}`,
      at: M.shot.at,
      meta: M.shot.meta,
      // `legend` is the service's OWN swatches for that layer — what makes the
      // report appendix a legend the picture can actually be read against,
      // rather than a list of names beside a map full of unexplained colour.
      layers: rows.map((r) => ({
        id: r.id, name: r.name, group: r.group, service: r.service, url: r.url, sublayer: r.sublayer,
        legend: r.legend, legend_more: r.legendMore,
      })),
    };
    M.capture = record;
    if (M.hooks.onAdd) { try { M.hooks.onAdd(record); } catch (e) { console.error("ESS map: onAdd failed", e); } }
    if (btn) { const t = btn.textContent; btn.textContent = "Added to the report ✓"; setTimeout(() => { btn.textContent = t; }, 1800); }
    renderCaptureCard(`✓ Captured and added to the report — ${rows.length} layer${rows.length === 1 ? "" : "s"} recorded in the appendix.`, "ok");
  }

  // ------------------------------------------------------------- diagnostics
  function diagnosticsText() {
    const d = M.diag || freshDiag();
    const view = M.view;
    const L = [];
    L.push("ESS Workbench — Queensland Globe map diagnostics");
    L.push(new Date().toLocaleString());
    L.push("");
    L.push(`Site:          ${M.site ? M.site.name : "—"}${M.site && M.site.station_num ? ` (${M.site.station_num})` : ""}`);
    L.push(`Station pin:   ${M.site ? fmtCoord(M.site.lat, M.site.lon) : "—"}`);
    if (view && view.center && typeof view.center.latitude === "number") {
      L.push(`View centre:   ${fmtCoord(view.center.latitude, view.center.longitude)}     Scale: ${view.scale ? `1:${Math.round(view.scale).toLocaleString()}` : "—"}`);
      L.push(`Pin in view:   ${pinInView() ? "yes" : "** NO — the map is not framed on the station **"}`);
    }
    L.push("");
    L.push(`Esri CDN: ${d.esri.status || "pending"}${d.esri.ms != null ? ` (${(d.esri.ms / 1000).toFixed(1)} s)` : ""}${d.esri.note ? ` — ${d.esri.note}` : ""}`);
    L.push(`Aerial imagery: ${d.imagery.status || "pending"}${d.imagery.ms != null ? ` (${(d.imagery.ms / 1000).toFixed(1)} s)` : ""}${d.imagery.mode ? ` [${d.imagery.mode}]` : ""}${d.imagery.note ? ` — ${d.imagery.note}` : ""}`);
    L.push("");
    L.push("Services:");
    Object.keys(SERVICES).forEach((k) => {
      const s = (d.services || {})[k];
      if (!s) return;
      const lg = (d.legends || {})[k];
      L.push(`  ${SERVICES[k].label}: ${s.status}${s.ms != null ? ` (${(s.ms / 1000).toFixed(1)} s)` : ""}${s.count != null ? `, ${s.count} sublayers` : ""}${s.sublayers ? `, drawing ${s.sublayers}` : ""}${s.note ? ` — ${s.note}` : ""}`);
      // Symbology is what puts a legend box in the report appendix, so a
      // service whose legend never read has to be visible here too.
      if (lg) L.push(`      symbology: ${lg.status}${lg.count != null ? `, ${lg.count} sublayers` : ""}${lg.note ? ` — ${lg.note}` : ""}`);
    });
    L.push("");
    const idf = d.identify || {};
    L.push(`Click-to-identify: ${idf.status || "idle"}${idf.services != null ? ` — asked ${idf.services} service(s)` : ""}${idf.found != null ? `, ${idf.found} feature(s) at the point` : ""}${idf.failed ? `, ${idf.failed} could not be asked` : ""}`);
    L.push("");
    L.push("Layers ticked:");
    LAYER_GROUPS.forEach((g) => g.layers.forEach((l) => {
      if (!M.selection.has(l.id)) return;
      const r = M.resolved[l.id];
      L.push(`  [${r && r.status === "ok" ? "drawn" : (r ? r.status : "pending")}] ${l.name}${r && r.status === "ok" ? ` → sublayer ${r.sublayer} (${r.via})` : (r && r.note ? ` — ${r.note}` : "")}`);
    }));
    L.push("");
    const ss = d.screenshot || {};
    L.push(`Capture: ${ss.status || "idle"}${ss.dims ? ` — ${ss.dims}` : ""}${ss.note ? ` — ${ss.note}` : ""}${typeof ss.coverage === "number" ? ` — ~${Math.round(ss.coverage * 100)}% covered, ${ss.distinct} distinct colours` : ""}`);
    if (ss.suspended != null) L.push(`View suspended at capture: ${ss.suspended ? "YES — this is the blank-map failure" : "no"}`);
    L.push("");
    L.push("Live render state:");
    if (view) {
      let drawing = 0, total = 0;
      try { const a = view.allLayerViews.toArray(); total = a.length; drawing = a.filter((lv) => lv.updating).length; } catch (_) {}
      L.push(`  suspended:${!!view.suspended} ready:${view.ready !== false} updating:${!!view.updating} size:${view.width || 0}×${view.height || 0}`);
      // A view with no projection can never become ready, draws nothing and
      // creates no layer views — say so here rather than leave a bare
      // "ready:false" to be puzzled over.
      const sr = view.spatialReference;
      L.push(`  projection:   ${sr && sr.wkid ? `wkid ${sr.wkid}` : sr ? "set (no wkid)" : "** none — the view cannot become ready until a layer or an explicit spatialReference gives it one **"}`);
      L.push(`  layer views: ${total} total, ${drawing} still drawing`);
    } else L.push("  (no view)");
    L.push("");
    L.push("Activity log:");
    (d.log.length ? d.log : ["(nothing logged yet)"]).forEach((l) => L.push(`  ${l}`));
    return L.join("\n");
  }
  function renderDiagnostics() {
    const pre = M.hosts.diagText;
    if (!pre || !M.open) return;
    pre.textContent = diagnosticsText();
  }

  // ------------------------------------------------------------------- modal
  function buildModal() {
    if (M.overlay) return M.overlay;
    const overlay = el("div", { class: "qm-overlay", role: "presentation", hidden: true });
    overlay.innerHTML = `
      <div class="qm-dialog" role="dialog" aria-modal="true" aria-labelledby="qm-title">
        <div class="qm-head">
          <div class="qm-head-titles">
            <h2 id="qm-title">Queensland Globe — site map</h2>
            <p class="qm-sub">Check the station pin is where it should be, choose the layers, then capture the map for the report. <b>Click anywhere on the map</b> to see which layers cover that point.</p>
          </div>
          <div class="qm-head-actions">
            <button type="button" class="btn secondary qm-recentre" title="Re-frame the map on the station coordinate">Centre on station</button>
            <button type="button" class="btn primary qm-capture" title="Take a picture of the map exactly as you see it here and put it straight into the report">Capture map for the report</button>
            <button type="button" class="qm-close" aria-label="Close">✕</button>
          </div>
        </div>
        <div class="qm-banners"></div>
        <div class="qm-body">
          <aside class="qm-panel">
            <div class="qm-cap-card">
              <div class="qm-panel-head">Picture for the report</div>
              <p class="qm-cap-how">The map itself <em>is</em> the picture — frame it, wait for the bar at its bottom to finish, then press the button below. One press captures the view and puts it in the report.</p>
              <button type="button" class="btn primary qm-cap-go" title="Take a picture of the map exactly as you see it here and put it straight into the report">Capture map for the report</button>
              <div class="qm-cap-state">Nothing captured yet.</div>
              <img class="qm-cap-thumb" alt="Preview of the captured map" hidden>
              <p class="qm-cap-note">The layer list travels with it into the report appendix — it is deliberately kept off the picture and out of the report body.</p>
            </div>
            <div class="qm-panel-block">
              <div class="qm-panel-head">Layers <span class="qm-layer-summary"></span></div>
              <input type="search" class="qm-search" placeholder="Filter layers…" aria-label="Filter layers">
              <div class="qm-panel-actions">
                <button type="button" class="btn tiny qm-preset" data-preset="default">ESS default</button>
                <button type="button" class="btn tiny qm-preset" data-preset="none">Clear all</button>
                <button type="button" class="btn tiny qm-preset" data-preset="all">Select all</button>
              </div>
              <div class="qm-layer-list"></div>
            </div>
            <details class="qm-diag">
              <summary>Map diagnostics</summary>
              <div class="qm-diag-body">
                <p class="qm-diag-hint">If the map misbehaves, open this, press Copy, and paste it back — it says exactly which service worked and which didn't.</p>
                <button type="button" class="btn tiny qm-diag-copy">Copy diagnostics</button>
                <pre class="qm-diag-text"></pre>
              </div>
            </details>
          </aside>
          <div class="qm-map">
            <div class="qm-onmap qm-onmap-left" aria-hidden="true"></div>
            <div class="qm-onmap qm-onmap-right" aria-hidden="true"></div>
            <div class="qm-pop" role="dialog" aria-label="Layers at the clicked point" hidden></div>
            <div class="qm-status"></div>
            <div class="qm-scalehint" hidden></div>
            <div class="qm-progress" hidden role="progressbar" aria-label="Map build progress" aria-valuemin="0" aria-valuemax="100">
              <span class="qm-progress-note">Building map…</span>
              <div class="qm-progress-bar"></div>
            </div>
          </div>
        </div>
      </div>`;
    document.body.append(overlay);
    M.overlay = overlay;
    const q = (sel) => overlay.querySelector(sel);
    M.hosts = {
      dialog: q(".qm-dialog"), map: q(".qm-map"), status: q(".qm-status"), banners: q(".qm-banners"),
      layerList: q(".qm-layer-list"), layerSummary: q(".qm-layer-summary"), search: q(".qm-search"),
      captureCard: q(".qm-cap-card"), diagText: q(".qm-diag-text"), scaleHint: q(".qm-scalehint"),
      progress: q(".qm-progress"), progressBar: q(".qm-progress-bar"), progressNote: q(".qm-progress-note"),
      furnitureL: q(".qm-onmap-left"), furnitureR: q(".qm-onmap-right"), resetView: q(".qm-recentre"),
      pop: q(".qm-pop"),
    };
    q(".qm-close").addEventListener("click", close);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    q(".qm-capture").addEventListener("click", (e) => captureForReport(e.currentTarget));
    q(".qm-cap-go").addEventListener("click", (e) => captureForReport(e.currentTarget));
    q(".qm-recentre").addEventListener("click", async () => { M.userFramed = false; clearBanners(); renderPanel(); await fitView(true); });
    M.hosts.search.addEventListener("input", renderPanel);
    overlay.querySelectorAll(".qm-preset").forEach((b) => b.addEventListener("click", () => {
      const p = b.dataset.preset;
      M.selection = new Set(p === "all" ? Object.keys(LAYER_INDEX) : p === "none" ? [] : DEFAULT_SELECTION());
      selectionChanged();
    }));
    q(".qm-diag-copy").addEventListener("click", async (e) => {
      const btn = e.currentTarget, text = diagnosticsText();
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
        else { const ta = el("textarea", {}); ta.value = text; document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
        btn.textContent = "Copied ✓";
        setTimeout(() => { btn.textContent = "Copy diagnostics"; }, 1800);
      } catch (_) { btn.textContent = "Copy failed — select the text below"; }
    });
    document.addEventListener("keydown", onKey);
    return overlay;
  }
  function onKey(e) {
    if (e.key !== "Escape" || !M.open || !M.overlay || M.overlay.hidden) return;
    // Escape dismisses the innermost thing first: the "what is here?" answer
    // before the whole map, so one stray key press cannot throw away the map.
    if (M.probe) closeProbe(); else close();
  }

  async function open(opts) {
    opts = opts || {};
    const site = opts.site;
    if (!site || site.lat == null || site.lon == null) return;
    M.site = site;
    M.hooks = { onChange: opts.onChange, onAdd: opts.onAdd };
    M.capture = opts.capture || null;
    // A different site than the view was built for: throw the view away rather
    // than pan a stale map to a new place with the old site's framing.
    if (M.view && M.viewSiteKey !== siteKey(site)) {
      try { M.view.destroy(); } catch (_) {}
      M.view = null; M.esriMap = null; M.svcLayers = {}; M.userFramed = false;
      M.shot = { dataUrl: null, valid: false, at: null, meta: null };
    }
    M.viewSiteKey = siteKey(site);
    M.selection = new Set(Array.isArray(opts.selection) && opts.selection.length ? opts.selection.filter((id) => LAYER_INDEX[id]) : DEFAULT_SELECTION());

    buildModal();
    clearBanners();
    if (!M.view) M.diag = freshDiag();
    M.open = true;
    M.overlay.hidden = false;
    document.body.classList.add("qm-open");
    renderPanel();
    renderCaptureCard();
    renderDiagnostics();
    // Modal in name (role="dialog" aria-modal="true") but not in behaviour: Tab
    // used to walk out of the dialog and into the collection pane behind the
    // scrim, where focus was invisible and the operator had no way back. The trap
    // is app.js's — this module is only ever opened from there, so it has run.
    // Escape stays with onKey below, which closes the layer probe before the
    // modal; a second Escape handler in the trap would take both at once.
    M.release = window.ESSFocusTrap ? window.ESSFocusTrap(M.overlay.querySelector(".qm-dialog")) : null;
    M.overlay.querySelector(".qm-close").focus();
    showStatus('<div class="qm-loading"><span class="qm-spin" aria-hidden="true"></span>Loading map…</div>');
    setProgress(0.08, "Loading map library…");

    try {
      await loadEsri();
      setProgress(0.2, "Building the map…");
      if (!M.view) {
        await buildView(M.hosts.map);
        drawPin();
        await fitView();
      } else {
        drawPin();
        await fitView();
      }
      hideStatus();
      await syncLayers();
      updateScaleHint();
      renderCaptureCard();
      renderDiagnostics();
    } catch (err) {
      // A view that never came up must not be kept: re-opening the modal takes
      // the "already built" path, which would skip buildView entirely and leave
      // the operator with a permanently blank map — no error, no retry — even
      // once the service is back. Throw it away so the next open rebuilds.
      if (M.view && !M.view.ready) {
        try { M.view.destroy(); } catch (_) {}
        M.view = null; M.esriMap = null; M.svcLayers = {}; M.pinGraphic = null;
      }
      setProgress(1, "");
      showStatus(`<div class="qm-offline"><b>🗺️ The map could not start.</b><span>${esc(err.message || "Could not load the map.")}</span><span>Open “Map diagnostics” in the panel for the detail.</span></div>`);
      renderFurniture();
      renderDiagnostics();
    }
  }

  function siteKey(s) { return `${s.name}|${s.lat}|${s.lon}`; }

  function close() {
    if (!M.overlay) return;
    closeProbe();   // a stale answer must not be sitting there on the next open
    M.open = false;
    M.overlay.hidden = true;
    document.body.classList.remove("qm-open");
    // Releases the Tab trap and returns focus to the card button that opened it.
    if (M.release) { M.release(); M.release = null; }
  }

  // -------------------------------------------------------- public interface
  window.ESSQldMap = {
    open,
    close,
    // Resolve a saved list of layer ids back into describable rows. This is what
    // lets a findings file that recorded only the ticked IDS still produce a
    // real report appendix. An id the catalogue no longer knows is dropped
    // rather than rendered as a mystery entry.
    describe: (ids) => (ids || []).map((id) => {
      const hit = LAYER_INDEX[id];
      if (!hit) return null;
      return { id, name: hit.layer.name, group: hit.group.title, service: SERVICES[hit.layer.svc].label, url: SERVICES[hit.layer.svc].url };
    }).filter(Boolean),
  };
})();
