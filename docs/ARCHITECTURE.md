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
  its coordinate-aimed deep-link;
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
- persists per-site state in `localStorage`, split across two keys per site: a
  small **text** key (findings text, report, prefs — rewritten on every keystroke)
  and a larger `…:img` key holding the photos + satellite map data URLs (rewritten
  only when images change). This keeps note editing fast on image-heavy sites;
  legacy single-key saves are migrated to the split layout on first edit;
- exports Print/PDF, self-contained HTML, and a JSON findings object — photos
  are embedded inline in all three.

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
`{ schema, generated, tool, site, sections[], collection_log[] }`, statuses
`found|none|failed|manual|unset`. It is emitted by `app.js reportObject()`,
scaffolded by `resolve.py --template`, and consumed by `app.js importFindings()`
— so a file the skill writes and a file the tool exports are interchangeable.
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
from the collection result.

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
