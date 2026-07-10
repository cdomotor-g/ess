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
- persists per-site state in `localStorage`;
- exports Print/PDF, self-contained HTML, and a JSON findings object.

### Agent skill (`.claude/skills/ess-collect/`)
`resolve.py` does the deterministic half (resolve station, filter sources, fill
URL templates) and prints the worklist. `SKILL.md` tells the agent how to work
through each source, when to use each status, the ALA API recipe, and the report
format. The agent can reach sources a browser can't (server-side fetch, web
search) and reason about page content.

## Data model

### `stations.json` — array of
```jsonc
{
  "name": "WOODGATE ALERT",
  "station_num": "539251",
  "wmo": "",
  "region": "QLD",           // raw BOM delivery region
  "state": "QLD",            // normalised (TAS/ANT->TAS, HO->by coords)
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
