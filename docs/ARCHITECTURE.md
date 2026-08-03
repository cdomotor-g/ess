# Architecture

## The idea

An ESS is a desktop assessment: for a site, check a fixed set of environmental
and heritage sources and record what each one says. The work is repetitive and
the source list is stable but grows over time. So the design separates three
things:

1. **What the sites are** — refactored out of the BOM workbook into
   `data/stations.json`.
2. **What to check and how** — a declarative registry, `data/sources.json`.
3. **Who does the checking** — either a person driving the browser tool, or an
   agent driving the `ess-collect` skill. Both read (1) and (2).

Because the "what" is data, not code, the tool grows by editing JSON, and both
front-ends stay in sync automatically.

```
          BOM FWIN ESS Template.xlsx   (raw, git-ignored, internal)
                     │
                     │  build/build_data.py   (run when the workbook updates)
                     ▼
        ┌──────────────────────────────────────────────┐
        │  data/                                        │
        │   stations.json   sources.json   dropdowns.json│
        └──────────────────────────────────────────────┘
                     │                         │
        ┌────────────┘                         └────────────┐
        ▼                                                   ▼
   index.html + assets/app.js                  .claude/skills/ess-collect/
   (browser tool, GitHub Pages)                 SKILL.md + resolve.py
        │                                                   │
        ▼                                                   ▼
   Interactive dashboard + report              Agent findings report
   (Found/None/Failed/Manual per source)       (same status taxonomy + JSON)
```

## Components

### Data build (`build/build_data.py`)
Reads the workbook and emits clean JSON. Key job: **union every station-bearing
tab**. No single tab is complete — the broad `EAMS DATA SET` export is missing
~315 Flood Warning Network sites (e.g. WOODGATE ALERT / 539251) that live only in
the `Station Data Sheet` autofill list. The build merges EAMS + the FWN list +
the categorised tabs (Rainfall, Manual Stations, Offices, …), de-duplicates by
station number, unions facility types, and attaches per-state reference links.
Output is deterministic (sorted) for clean diffs. Provenance (source hash,
counts) goes in `data/meta.json`.

Each station's `state` (what drives state-specific tool lookups) is resolved
geographically from its own lat/lon via `build/geostate.py` — a point-in-polygon
test against real state boundaries (`data/reference/au_states.geojson`, Natural
Earth 1:10m admin-1, public domain) — rather than trusted from the workbook's
`Region` column, which is a BOM delivery/administrative grouping that can
disagree with geography right along state borders. `resolve.py` (the skill) and
`assets/app.js` (manual coordinate entry / imports) use the same module/logic
for sites resolved outside the workbook.

### Sources registry (`data/sources.json`)
The heart of the system. A list of source objects, each describing one thing to
check: which ESS category and state(s) it applies to, its URL (optionally a
`url_template` with coordinate placeholders), how it's checked (`method`), and
what to look for. Consumed identically by the browser tool and the skill. Full
schema in [ADDING-A-SOURCE.md](ADDING-A-SOURCE.md).

### Browser tool (`index.html` + `assets/app.js`)
Vanilla JS, no dependencies, no build. It:
- indexes `stations.json` for autocomplete and replicates the workbook's VLOOKUP
  autofill;
- filters `sources.json` to the site's state and renders a card per source with
  its coordinate-aimed deep-link. A card is laid out in **three zones, in the
  order an opinion forms** (`renderSourceCard`): **identity** (number, monogram,
  name, and an `ⓘ` disclosure holding the jurisdiction/method tags, the static
  "what to look for" prose, the steps and the URL) → **finding** (`result_text`
  first, labelled *What came back* and tinted to the result, clamped to four
  lines with a measured *Show all*; then the operator's own note, sized to its
  content; then evidence photos behind a compact **＋ Add photo**) →
  **disposition** (record the result → open the source → route it to a report
  section → **✓ Reviewed**, last control on the card in DOM and visual order).
  The result is stated **once** on a resting card: the recorded value is a chip
  that expands back into the four-way picker on click, and an unanswered card
  shows the picker outright, since answering it is that card's whole job.
  Occasional utilities (copy lat/long, web search, jump to the report, clear the
  note) are in a per-card `⋯` menu. Everything behind `ⓘ`, `⋯` and `＋ Add photo`
  is **built on first open**, so 23 cards cost 23 buttons rather than 23 copies
  of prose and tooling nobody has asked for yet;
- renders each card at **one of three densities, derived from its state** and
  never from what has been clicked (`cardDensity`): a **reviewed** card is one
  ~36 px line (number, result glyph, name, target section, tick), an **answered
  but unreviewed** card is a ~120 px summary (identity, two lines of the finding
  or the operator's note, the result, and the review tick), and anything a human
  still owns — *Manual*, *Search failed*, *Not checked* — renders in full.
  Clicking a collapsed card opens it in place; that expansion is transient, so
  the next full render returns the pane to a picture of state rather than of
  click history. Within a category, cards sort **attention first**
  (unset → failed → manual → found → none → reviewed) unless the operator
  switches the dashboard's `Sort:` control to source order (remembered per
  browser). Each category header carries its own roll-up — `n sources · n found
  · n need you` — and a category with nothing outstanding folds to that header;
  the per-category open/closed choice is remembered per site;
- calls the one live API (Atlas of Living Australia) directly from the browser;
- tracks a status per source and assembles a report using the standardized
  wording from `dropdowns.json`;
- lets you attach photos — pasted from the clipboard, dragged in, or chosen via
  a file picker — both a general station gallery and per-source evidence
  photos on biosecurity-relevant sources (weeds, pests, disease, threatened
  species); photos are downscaled client-side and kept as JPEG data URLs;
- auto-sources a **reference/identification photo from Wikipedia** for a named
  subject (a weed, feral animal or pathogen) on the species cards: it searches
  the MediaWiki API for the article, fetches the lead image, re-encodes it
  through a canvas to a self-contained JPEG data URL (same shape as an uploaded
  photo, plus a licensing `credit` + `source_url`), and attaches it to the card
  — so a user doesn't have to go and find one. Runs entirely in the user's
  browser (MediaWiki returns anonymous CORS; `upload.wikimedia.org` allows the
  cross-origin canvas read); network/CORS failures are non-fatal. The same
  pipeline runs **automatically**: an "Auto from notes" button (and note-blur,
  when enabled) scans a card's free-text findings for subjects and fetches a
  photo for each; imports and live agent runs do the same from `image_subjects`
  (or extracted text). Extraction is deliberately high-precision — only curated
  reference-list names and scientific binomials, never bare capitalised words —
  so a wrong photo isn't attached; a global toggle (default on) governs it;
- renders the auto **satellite locator map** by stitching keyless Esri World
  Imagery tiles onto a canvas with a pin, and (default on, toggleable) composites
  transparent Esri road + locality/place **reference overlays** on top — same
  host/CORS as the imagery, so the result stays a self-contained, exportable
  JPEG. The chosen span (km) and the labels toggle persist per site and travel
  into the report + exports;
- orders the **left column as the workflow itself** — ① choose a site, ② check the
  site details, ③ run the checks, ④ finish & include each source, with ⑤ the report
  in the right column. Step ③ (`#run-checks`) holds the whole assistant round trip
  in one card: **Run auto-checks**, **Copy prompt** and the box the JSON reply is
  pasted into, so it never needs a scroll. Everything belonging to a *different*
  way of working — batches, file imports, the BYOK agent, display preferences —
  lives in the `<details id="advanced">` card at the foot of the column, closed by
  default (open state remembered), which is why a first-time operator sees only
  the four steps;
- lays the workspace out as **two independently scrolling columns** (collection
  left, report right) sized to the viewport below the topbar. Each column pins
  what has to stay reachable while the other content scrolls: the progress card on
  the left, the report's export toolbar on the right, and the dashboard's category
  headings under the progress card. The pinned offsets are measured into CSS
  variables by `app.js` (`--topbar-h`, `--progress-h`) rather than hard-coded,
  because both boxes change height with content and window width. The handles on
  the seam collapse either column so the other takes the full width — one at a
  time, remembered in `localStorage`;
- persists per-site state in `localStorage`, split across two keys per site: a
  small **text** key (findings text, report, prefs — rewritten on every keystroke)
  and a larger `…:img` key holding the photos + satellite map data URLs (rewritten
  only when images change). This keeps note editing fast on image-heavy sites;
  legacy single-key saves are migrated to the split layout on first edit;
- exports Print/PDF, self-contained HTML, and a JSON findings object — photos
  are embedded inline in all three.

### Queensland Globe site map (`assets/qldmap.js`)
A separate, lazily-initialised module behind `window.ESSQldMap`. It draws a
**real interactive ArcGIS map** of the site — Queensland aerial imagery with the
ESS environmental layer stack over it and the station pinned — so the operator
can sanity-check the position and what the layers show, then capture that exact
view for the report. It is only offered on QLD sites, from the Queensland Globe
collection card.

- **Nothing loads until it's opened.** The Esri bundle (~1 MB from
  `js.arcgis.com`) and every QLD service call happen on first open, so the
  workbench stays a fast, dependency-free page for the sessions that never use
  the map.
- **Sublayer IDs are resolved at runtime, never hardcoded.** Queensland's
  MapServer sublayer IDs are undocumented and not stable, so every catalogue
  entry declares a name `match` and each service's live layer list (`?f=json`)
  is read once per open and matched by name; a `fallback` id is a last resort.
  A layer that resolves to nothing is **withheld** and says so — in the panel
  and in the diagnostics — rather than silently drawing the wrong dataset.
- **The aerial imagery goes on the map *before* the `MapView` is constructed.**
  This ordering is load-bearing, not cosmetic. A 2D `MapView` takes its spatial
  reference from, in order, an explicit `spatialReference`, the basemap, then the
  first layer on the map — and there is no Esri basemap to lean on here, because
  those need an API key. Built over an empty `Map` the view never resolves a
  projection, so it creates no layer views, never reaches `ready`, and
  `view.when()` never settles: the modal times out with *"the map could not
  start"* while every layer still reads `pending`. If the ImageServer is
  unreachable the view is told the projection outright (Web Mercator) and opens
  without a base picture, rather than leaving a dead modal. The diagnostics print
  the view's projection so this state names itself.
- **One `MapImageLayer` per service, not per layer.** Forty-odd catalogue
  entries map onto ~15 services; drawing each as its own layer would be forty
  `exportImage` round-trips per pan. Toggling a layer flips one sublayer's
  `visible` on a layer that already exists.
- **Everything external is bounded and self-reporting.** Each call has a
  timeout, each failure is worded for a non-developer, and a per-service
  diagnostics panel (copyable as plain text) says exactly what worked. One
  layer failing never stops the map, the pin, or the capture.
- **The capture is guarded.** The raw screenshot raster is measured before any
  fill is painted over it: a mostly-transparent, few-colour frame means the map
  never rendered (typically a suspended view), and it is refused with an
  explanation rather than exported as a plausible-looking blank.
- **One press captures AND adds.** Capturing and adding were separate buttons;
  the second press decided nothing and was mostly forgotten, leaving a captured
  map that never reached the report. `captureForReport()` does both, from either
  the header button or the one in the capture card, and the thumbnail is the
  receipt. The card is the FIRST thing in the panel — taking the picture is what
  the modal is for, so it does not sit below sixty layer checkboxes.
- **"Is the pin in shot?" is provenance, not a warning.** `pinInView()` asks the
  view where the pin lands in screen pixels (`view.toScreen`), which needs no
  projection engine and assumes nothing about the map's CRS — unlike an
  `extent.contains()` test, which compares degrees against a projected extent in
  metres and calls a well-framed map "outside". The answer is recorded with the
  capture and printed in the diagnostics, but it no longer raises an alarm on the
  card: the check was wrong often enough that the warning trained operators to
  ignore the one place the capture reports itself.
- **Layers go to an appendix, not onto the picture.** A ticked stack is far too
  long for an on-map legend or a report section, so the picture carries only the
  site, coordinate, scale and layer *count*, and the full list travels into
  **Appendix A** of the report (see below). `state.qldMap` holds the ticked
  selection (persisted, so re-opening restores the stack) and the capture record
  that the appendix renders from.
- **Click the map to ask what is under that point.** Forty translucent layers
  stack on one picture and the panel's group colours are *ours*, not the
  services' — so a shaded patch cannot be read back to a layer by eye. A click
  runs one ArcGIS `identify` per MapServer (restricted to the ticked sublayers,
  `all:` so a scale-suppressed layer still answers) and names every layer
  covering the point in a popup, with the feature's own attributes and the
  service's legend swatch. One call per *service* for the same reason the map
  draws one `MapImageLayer` per service. A service that cannot be asked is
  **named** in the popup — "nothing is here" and "we could not ask" are very
  different answers. The built-in Esri popup is disabled (`popupEnabled=false`)
  so two popups never fight over one click, and the ring marking the asked-about
  point is removed before every screenshot so it can't reach the report.
- **Symbology comes from `/legend?f=json`, never invented.** Each service
  publishes the exact PNG swatches it paints with. They feed both the click
  popup and the per-layer **legend boxes in Appendix A**, so a colour on an
  exported map can be traced to the layer that drew it. A swatch is only shown
  against an identified feature when it can be matched with certainty (by the
  renderer's `values`, then its label) — a wrong colour beside a layer name is
  worse than none. Legends are read in the background as the map draws and
  awaited (bounded) before a capture; a layer without one still reaches the
  appendix by name.

`app.js` owns all persistence and passes two callbacks in — `onChange` (ticks
changed) and `onAdd` (a captured map). The picture follows the ordinary card-image
path into the report and every export; the layer list is exported as a top-level
`qld_globe_map` object in the JSON findings, so a re-imported report rebuilds its
appendix even without the picture.

The capture record's **legend swatches are base64 PNGs**, so they are split out
of the per-site *text* payload (rewritten on every keystroke) and stored with the
images, which are only rewritten when an image changes; `restore()` reunites them.
In the report the captured map is not treated as an evidence thumbnail: it is
rendered full width with the height following the width, and clicking it opens it
full screen — via the existing lightbox on screen, and via a script-free
`:target` overlay in the exported HTML, so a saved copy still works offline.

### Agent skill (`.claude/skills/ess-collect/`)
`resolve.py` does the deterministic half (resolve station, filter sources, fill
URL templates) and prints the worklist. `SKILL.md` tells the agent how to work
through each source, when to use each status, the ALA API recipe, and the report
format. The agent can reach sources a browser can't (server-side fetch, web
search) and reason about page content.

## Agent paths and the shared findings schema

The tool is the **reviewer/exporter**; the agent is the **engine**. Two agent
paths fill the same state, and the browser's own live checks (ALA) do too:

```
   Claude Code (file handoff)          BYOK in-browser agent (assets/agent.js)
   resolve.py --template → fill        your key → api.anthropic.com direct;
   → ess-findings/1 JSON → Import      server-side web_search/web_fetch (no CORS)
            │                          + client tools query_ala / set_source_result
            └───────────────┬───────────────────────┘
                            ▼
             app.js state.findings / state.report
             (importFindings ‖ setResult ‖ live ALA check)
                            ▼
        review Manual/Failed  →  finalise wording  →  export (PDF / HTML / JSON)
```

**One schema ties it together — `ess-findings/1`:**
`{ schema, generated, tool, site, sections[], collection_log[], qld_globe_map? }`, statuses
`found|none|failed|manual|unset`. It is emitted by `app.js reportObject()`,
scaffolded by `resolve.py --template`, and consumed by `app.js importFindings()`
— so a file the skill writes and a file the tool exports are interchangeable.
**Importing a file for the site already open merges rather than replaces**
(`applyFindings` → `isSameSite` → `mergePrevious`): an entry that carries no
status, note, result or photo leaves the existing result alone, and the
operator's own bookkeeping (review tick, include target, card photos) carries
across an entry that does. This is what lets the primary workflow run the
auto-checks *before* the assistant's reply comes back without the reply undoing
them. A file for a different site replaces the workspace as before.
`site` and each `sections[]`/`collection_log[]` entry may carry an optional
`images: [{ caption, data_url, credit?, source_url? }]` — populated by the
browser tool (uploaded photos, or reference images auto-sourced from Wikipedia,
which also set `credit`/`source_url`; agents don't attach photos); re-importing
a previously exported file restores them (the `source_url` link is constrained
to `http(s)` on import). Each **species/subject** `collection_log[]` entry
(invasive plants/animals, disease, threatened) may also carry an optional
`image_subjects: string[]` — the identifiable species/subjects an agent found.
It's a *hint*, not stored photo data: on import (and during a live agent run) the
browser tool fetches a labelled Wikipedia reference photo for each name and adds
it to that card's `images`. When it's absent, the tool falls back to extracting
subjects from the entry's `note`/`result_text`. Auto-fetch is gated by a
tool-side toggle (default on) and never overwrites existing photos.

An optional top-level `qld_globe_map` carries the provenance of the Queensland
Globe site map: `{ captured_at, lat, lon, scale, pin_in_view, selection[],
layers: [{ id, name, group, service, url, sublayer, legend?, legend_more? }] }`,
where `legend` is `[{ label, swatch }]` — the service's own symbol for that layer
as a `data:` image, capped per layer with `legend_more` counting the rest. It is
deliberately **not** nested under `site` — the report's Appendix A is built from
it directly, so a re-imported file lists the layers the map was drawn from, *and
what each one looks like on it*, even when the picture itself didn't survive the
round trip. Every swatch is re-validated as a `data:` image on import, the same
way photos are. Agents don't produce any of this; only the browser tool's map
modal does. The captured map itself travels as an ordinary card image marked
`kind: "qld_globe_map"`, which is what tells the report to render it full width
and clickable rather than as a thumbnail.

**Integration seam.** `app.js` exposes a tiny `window.ESS` (`site()`,
`sources()`, `setResult()`, `queryAla()`, `beginRun()`/`endRun()`). The optional
`assets/agent.js` consumes only that surface — if it isn't loaded, nothing about
the core tool changes. The BYOK agent holds the key in `localStorage`, calls
`api.anthropic.com` directly (`anthropic-dangerous-direct-browser-access`), and
runs a manual tool-use loop (server tools resolve inline; client tools
`query_ala` / `set_source_result` the browser executes; `pause_turn` re-sends).
`API_BASE` is a single constant so a future default-key proxy is a one-line swap.
See [AGENT-MODE.md](AGENT-MODE.md).

## Data model

### `stations.json` — array of
```jsonc
{
  "name": "WOODGATE ALERT",
  "station_num": "539251",
  "wmo": "",
  "region": "QLD",           // raw BOM delivery region (administrative, not geographic)
  "state": "QLD",            // resolved geographically from lat/lon (build/geostate.py);
                              // region is only a fallback when coordinates don't resolve
  "delivery_group": "OOH-B",
  "facility_types": ["Flood Warning Network"],
  "primary_facility": "Flood Warning Network",
  "lat": -25.0891, "lon": 152.5489,
  "operating_authority": "Bureau of Meteorology",
  "ident": "",
  "refs": {                  // state-based reference links (proforma hyperlinks)
    "invasive_plants": "https://…",
    "invasive_animals": "https://www.dcceew.gov.au/environment/invasive-species",
    "diseases": "https://www.outbreak.gov.au/"
  },
  "sources": ["Station Data Sheet"]   // which workbook tab(s) it came from
}
```

### `sources.json` — `{ categories, epbc_matters, sources[] }`
Each source: `id, name, category, jurisdiction, states[], method, cors, url`,
optional `url_template, api, internal, web_search, what_to_find, instructions,
no_result_means, priority`. See [ADDING-A-SOURCE.md](ADDING-A-SOURCE.md).

### `dropdowns.json`
The exact proforma statement lists per section, plus `biosecurity_detail`
mapping each biosecurity level to its declaration text. Lists are ordered
`[no known…, known…, …local area]` so a front-end can suggest the right option
from the collection result. **Build-generated** from the FWIN ESS Template — do
not hand-edit.

### `statements.json`
Hand-authored narrative templates (durable; *not* build-generated) that seed the
report-section detail text: the impact-assessment sentence, per-state General
Biosecurity Obligation paragraphs, the QLD Koala Conservation Plan district logic
+ link, cultural-heritage duty-of-care, and the migratory/acid-sulfate notes.
Consumed by `assets/app.js` (PMST import section-seeding and the "Insert suggested
detail" button) and surfaced to the agent via `resolve.py --json`. Loaded
best-effort — a missing file just disables the auto-draft, never breaks the tool.

## The status taxonomy

Every source resolves to one of four, and the difference is the product:

- **Found** — returned something to record.
- **Nothing found** — checked successfully, nothing relevant.
- **Search failed** — could not get an answer (network / CORS / egress / error).
- **Manual** — needs a human (interactive GIS portal, draw-a-polygon report, or
  internal login), with the aimed link + steps.

"Nothing found" and "failed" are deliberately distinct: *absent* and *unknown*
are different risk positions for someone about to attend a site.

## Why client-side, and the egress caveat

The browser tool is fully client-side so it can live on GitHub Pages with no
backend and so the user's own browser makes the outbound calls. That matters:
government/ALA endpoints are reachable from a normal browser (subject to CORS)
but are often blocked from automated/CI egress. The tool treats any failed call
as a first-class *failed* status rather than hiding it — which is exactly the
signal an ESS needs. The agent skill has the same discipline: a blocked host is
reported, not silently skipped.

## URL templating

`url_template` may contain `{lat} {lon} {name} {state}` and a bounding box
(`{lat_min} {lat_max} {lon_min} {lon_max}`, ~3 km around the point) for map tools
that accept an extent. The browser (`buildUrl`) and `resolve.py` (`fill`) apply
the same substitutions, so a deep-link is identical in both.
