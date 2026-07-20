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
- **Satellite locator map + reference overlays** — an auto-generated Esri World
  Imagery locator (pinned, per-site km span) with optional road + locality/place
  overlays composited on top (default on, toggleable), baked into a self-contained
  exportable JPEG.
- **Photo evidence + auto-sourced reference images** — paste/drag/file-pick
  station and per-source evidence photos, plus a one-click **Fetch image** on the
  species cards (weeds, feral animals, disease, threatened) that pulls a labelled
  reference photo from Wikipedia with licensing attribution. All photos are
  embedded as data URLs, so they travel into the report and every export.
- **Automatic reference-image sourcing** — the same Wikipedia pipeline runs
  hands-free: an **Auto from notes** button (and note-blur) extracts species/
  subjects from a card's free-text findings, and **imports + live agent runs**
  fetch photos from the agent's `image_subjects` (or extracted text). Extraction
  is high-precision (curated lists + scientific binomials only); a global toggle
  governs it. Schema: optional `image_subjects[]` on species `collection_log`
  entries.
- **Batch mode** — a `ess-findings-batch/1` envelope (`{ sites: [ <ess-findings/1>,
  … ] }`) runs end-to-end: `resolve.py --batch` scaffolds many sites in one call
  (names/numbers or `lat,lon[,name]`, file or stdin; ambiguous/unresolved lines
  reported on stderr), the `ess-collect` skill fills each, and the browser's Import
  JSON tab detects the array and shows a **batch picker bar** — one chip per site
  with live found / needs-attention counts, persisted across visits, each opening
  into the same review/export surface. **🔍 Check all** copies one combined
  fact/consistency-check prompt for every site; **Clear batch** drops the grouping
  but keeps each site's saved work. To keep a large batch inside the localStorage
  quota, a loaded batch keeps each site's auto-generated satellite maps **in memory
  only** (they still render and travel into every export) and regenerates them when
  a site is reopened, rather than persisting two large map JPEGs per visited site;
  single-site work persists maps as before.
- **Report self-check prompt** — a **🔍 Check report** button (report toolbar)
  builds a self-contained fact-and-consistency-check prompt for the finished
  report and copies it for any assistant. The output contract is deliberately
  rigid (verdict → issues table → fact-check table → gaps, with word caps) so
  verbose/inconsistent assistants (e.g. 365 Copilot) return a usable review. It
  folds in the tool's own consistency warnings and takes a `reportObject()`-shaped
  object (`buildReviewPrompt`), so the batch flow reuses it per site. The toolbar's
  less-used exports (Print / JSON / Copy summary) moved under a **More ▾** menu.
- **Agent skill** — `ess-collect` with a deterministic `resolve.py` helper
  (incl. `--template` → the `ess-findings/1` skeleton) and a full playbook,
  emitting the same status taxonomy + JSON.
- **Agent ↔ tool interoperability** — one shared `ess-findings/1` schema; the
  tool imports the agent's findings (**Import agent findings** tab), surfaces
  Manual/Failed for review, and re-exports. "Copy agent prompt" for the reverse.
- **BYOK in-browser agent** (beta) — `assets/agent.js` runs the whole assessment
  from the browser with the user's own Anthropic key (server-side web
  search/fetch bypass CORS), filling the dashboard live. No backend.
- **Docs** — architecture, this roadmap, how to add a source, proforma mapping,
  agent mode.

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
- [x] **Map preview** of the site — done: a dependency-free satellite locator
      (Esri tiles stitched on a canvas) with road/locality overlays, in the site
      summary + report. A drawn search *buffer* ring could still be added.
- [x] **Batch mode** — done. `resolve.py --batch` resolves a list of sites
      (names/numbers or `lat,lon[,name]`, from a file or stdin) into one
      `ess-findings-batch/1` envelope; the skill fills each site; the browser
      imports the array and shows a picker bar (per-site found/attention counts,
      resumes across visits) with a **Check all** combined-review button. See
      Built.

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

### Phase 4 — Orchestration & shared agent access
- [x] **Agent as engine + file/live handoff** — done (see Built).
- [ ] **Shared / default key via a proxy.** So users don't paste their own key
      (a shared key *can't* live in static Pages — it would be published). Stand
      up a tiny access-controlled proxy (Cloudflare Worker / Lambda behind BOM
      SSO) holding the Anthropic key server-side (a GitHub secret can feed the
      Worker secret); point the browser at it. *Files:* new `proxy/` (worker +
      `wrangler.toml` + README); in `assets/agent.js` swap the `API_BASE`
      constant to the proxy origin and add a "My key / Shared endpoint" toggle.
      Must be authenticated + rate-limited (an open proxy on a shared key is an
      open wallet).
- [ ] **Managed Agents (CMA) variant** — instead of a self-run loop, broker an
      Anthropic-hosted session (loop + sandbox tools server-side) and render its
      SSE stream; still needs the credential home from the proxy above.
- [ ] **Streaming UX** for the BYOK agent (token-level progress) — currently
      updates per turn.
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
