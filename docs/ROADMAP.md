# Roadmap

This captures what's built, what's deliberately manual, and a prioritised
backlog — written so you can spin up a follow-up session and hand it a specific
slice. Each backlog item names the files to touch and how to verify.

## Built (Phase 0)

- **Station data refactor** — `build/build_data.py` unions every station tab of
  the workbook into `data/stations.json` (~6,600 sites), de-duplicated, with
  per-state reference links. Reproducible + deterministic.
- **Sources registry** — `data/sources.json`, 57 sources across all 8 ESS
  categories and every state, each with a coordinate-aimed deep-link and
  "what to find" guidance.
- **Browser tool** — station autofill, collection dashboard, live Atlas of
  Living Australia check, per-source Found/None/Failed/Manual, report builder
  with standardized wording, export to Print/HTML/JSON, localStorage
  persistence. Static → GitHub Pages.
- **Agent skill** — `ess-collect` with a deterministic `resolve.py` helper and a
  full playbook, emitting the same status taxonomy + JSON.
- **Docs** — architecture, this roadmap, how to add a source, proforma mapping.

## Deliberately manual (by nature, not backlog)

- **EPBC PMST** has no public API — it's a draw-a-polygon report generator.
  Always a *manual* step; the ALA check corroborates the species side.
- **Internal SharePoint** (Permits register, POPE/leasing, Bureau Heritage
  Register) needs Bureau login — *manual*.
- Most **state GIS portals** are interactive viewers; see Phase 2 for the ones
  with queryable services behind them.

## Backlog

### Phase 1 — Data & UX polish (small, high value)
- [ ] **Public station subset toggle.** Add a `--facility` / `--fwn-only` filter
      to `build/build_data.py` so a Pages deployment can ship, say, only Flood
      Warning Network sites. *Files:* `build/build_data.py`. *Verify:* row counts
      in build output + `data/meta.json`.
- [ ] **Adjustable ALA radius** in the UI (currently 10 km). *Files:*
      `assets/app.js` (`runAla`), a small control near the ALA card.
- [ ] **Map preview** of the site + buffer (Leaflet from a self-hosted tile or a
      static image). Keep it dependency-free / offline-friendly.
- [ ] **Batch mode** for the skill: take a list of stations and emit one report
      each. *Files:* `.claude/skills/ess-collect/` (a loop wrapper).

### Phase 2 — More live checks (the main automation win)
Each is: find the ArcGIS REST / WFS endpoint behind the portal, add an `api`
block to the source in `sources.json`, teach `assets/app.js` (`fetchJson` +
a new `api.kind` handler) and the skill how to query it, and set `cors` honestly.
Candidates, roughly in order of payoff:

| Source | Likely queryable service | Notes |
|--------|--------------------------|-------|
| QLD WetlandMaps / BioMaps | Qld Spatial ArcGIS `MapServer/identify` | Query wetland + essential-habitat layers by point. |
| NSW BioNet | BioNet Species Sightings API (has documented REST) | Threatened species by point/area — strong candidate. |
| VIC NatureKit / Biodiversity | DELWP ArcGIS FeatureServer | EVCs + modelled habitat by geometry. |
| WA NatureMap / Dandjoo | DBCA services | Threatened flora/fauna occurrence. |
| SA NatureMaps | DEW ArcGIS services | Similar to NSW/VIC. |
| Australian Heritage DB / state heritage | ArcGIS heritage layers where published | Point-in-polygon for listed places. |
| Acid Sulfate Soils | CSIRO ASRIS WMS/WFS | Probability class by point. |
| Indigenous Protected Areas | DCCEEW spatial layer if published | Point-in-polygon IPA check. |

For each, verify `cors` from a real browser (services vary); if a service is not
CORS-enabled, keep it `deep_link`/`manual` in the browser tool but let the skill
query it server-side.

### Phase 3 — Output that can replace the proforma
- [ ] **Populate the .xlsx proforma directly.** Write a small generator
      (Python `openpyxl` in `build/` or a separate `tools/`) that takes the JSON
      findings object and writes a filled copy of the ESS proforma sheet
      (station autofill cells + the chosen dropdown statements + notes). *Verify:*
      open the output and diff against a manually completed ESS.
- [ ] **Branded PDF** matching the proforma layout (the current HTML export is a
      good base — refine the print CSS or generate via the xlsx path).
- [ ] **EAMS attachment helper** — pre-fill the Station Information tab text and
      naming (`ESS_Station Name_Station type_MM YYYY`) from the report object.

### Phase 4 — Orchestration
- [ ] **One-click "run everything the browser can"** already exists (⚡ Run
      auto-checks); extend as more `api` sources land.
- [ ] **Scheduled re-assessment** — re-run a site periodically and diff findings
      (new outbreak zone, new listing) using the JSON export as the baseline.
- [ ] **Record register integration** — append completed ESS metadata to the
      "Enviro Management Plans, Site Summaries and Planned Works" register.

## Data governance

`data/stations.json` is published on Pages. It is Bureau site names + coordinates
(largely public), but confirm before publishing, and use the Phase 1 subset
toggle if a narrower list is wanted. The raw workbook is never committed
(`build/source/` is git-ignored) so internal screenshots / SharePoint links stay
out of the repo.

## Spinning up a follow-up session

Point a new session at this repo and give it one backlog item, e.g.:

> Implement Phase 2 "NSW BioNet" from docs/ROADMAP.md: add an `api` block to the
> `nsw-bionet` source in data/sources.json, add a `bionet` handler in
> assets/app.js next to the ALA one, and teach the ess-collect skill to call it.
> Verify with a NSW site and update the roadmap checkbox.

or

> Implement Phase 3 "populate the .xlsx proforma" from docs/ROADMAP.md.

Everything needed — the data model, the source schema, the status taxonomy — is
in `docs/` and `.claude/skills/ess-collect/SKILL.md`.
