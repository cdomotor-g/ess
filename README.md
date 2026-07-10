# ESS Workbench

A tool that helps generate **Environmental Site Summaries (ESS)** for Bureau of
Meteorology sites — pick a site by name (or drop in a latitude/longitude), and it
auto-populates the station metadata, opens every relevant environmental and
heritage source aimed at that location, runs the checks that can be automated,
and builds a report that flags **what was found, what was empty, and what
couldn't be checked**.

It has two halves that share the same data:

| Component | What it is | Runs where |
|-----------|-----------|-----------|
| **Browser tool** (`index.html`) | A static, single-page app. Station autofill, deep-linked collection dashboard, live Atlas of Living Australia check, and an exportable ESS report. | Any browser · GitHub Pages · offline |
| **`ess-collect` skill** (`.claude/skills/`) | Instructs a Claude Code agent to run the same desktop assessment and write a findings report — handling sources the browser can't reach. | Claude Code |

Both are driven by one extensible **sources registry** (`data/sources.json`) and
the refactored station dataset (`data/stations.json`), so adding a new search
tool updates both at once.

---

## Quick start

### Use the browser tool locally

```bash
# from the repo root — any static server works
python3 -m http.server 8000
# open http://localhost:8000/
```

Opening `index.html` directly with `file://` will **not** work (browsers block
`fetch()` of the JSON data from the filesystem). Serve it, or publish to Pages.

1. Type a station name/number, or switch to **By coordinates**.
2. The site summary auto-populates (station #, WMO, state, delivery group,
   facility, lat/long) — this replicates the workbook's VLOOKUP autofill.
3. Work down the **collection dashboard**. Each source opens aimed at the site.
   Hit **Check live** on the Atlas of Living Australia card; set a result on the
   rest: Found / Nothing found / Search failed / Manual.
4. The **ESS report** section fills with the standardized proforma wording and
   your collection evidence. Export to **Print/PDF**, **HTML**, or **JSON**.

Your work is saved in the browser (localStorage) per site, so you can come back
to it.

### Use the skill

In a Claude Code session in this repo:

> Run an ESS desktop assessment for WOODGATE ALERT

or

> Do an ESS for lat -25.0891 lon 152.5489

The `ess-collect` skill resolves the site, works through every source, and
produces a findings report with a status for each. See
[`.claude/skills/ess-collect/SKILL.md`](.claude/skills/ess-collect/SKILL.md).

---

## Publish to GitHub Pages

The whole thing is static — no build step.

1. Push this repo (or merge to your default branch).
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
   The included workflow ([`.github/workflows/pages.yml`](.github/workflows/pages.yml))
   deploys the repo root on every push to `main`.
   *(Alternatively choose **Deploy from a branch → main → / (root)** — a
   `.nojekyll` file is included so all `data/` and `assets/` files serve as-is.)*
3. Your tool is live at `https://<user>.github.io/<repo>/`.

> **Before you publish:** `data/stations.json` contains ~6,600 Bureau site names
> and coordinates. Confirm that's OK to host publicly. To ship a narrower list
> (e.g. only Flood Warning Network sites), filter in `build/build_data.py` and
> rebuild — see [docs/ROADMAP.md](docs/ROADMAP.md).

---

## Regenerating the station data

The station lists and standardized dropdown wording are refactored out of the
BOM *FWIN ESS Template* workbook into clean JSON. Only the derived JSON is
committed; the raw workbook stays out of the repo (`build/source/` is
git-ignored).

```bash
pip install -r build/requirements.txt
# drop the workbook in build/source/FWIN_ESS_Template.xlsx, then:
python build/build_data.py
```

This unions every station-bearing tab (EAMS master + the FWN autofill list +
the categorised tabs), de-duplicates by station number, and writes
`data/stations.json`, `data/dropdowns.json`, `data/reference/*` and
`data/meta.json`. Output is sorted/deterministic, so a `git diff` shows exactly
what changed between template versions. Details in
[`build/README.md`](build/README.md).

---

## Repository layout

```
index.html                     Browser tool (entry point)
assets/app.js, styles.css      Tool logic + styling (vanilla, no dependencies)
data/
  stations.json                ~6,600 Bureau sites (name -> metadata + refs)
  sources.json                 Extensible registry of every ESS search source
  dropdowns.json               Standardized proforma statement lists
  reference/                   Weeds list, disease notes
  meta.json                    Build provenance (source hash, counts, date)
build/
  build_data.py                Refactors the workbook -> data/*.json
  source/                      (git-ignored) drop the raw workbook here
.claude/skills/ess-collect/    Agent skill: SKILL.md + resolve.py helper
docs/                          Architecture, roadmap, how to add a source, mapping
.github/workflows/pages.yml    GitHub Pages deploy
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — how the pieces fit and the data model.
- [Roadmap](docs/ROADMAP.md) — what's built, what's next, the automation backlog.
- [Adding a source](docs/ADDING-A-SOURCE.md) — extend the registry (the main way
  this grows).
- [Proforma mapping](docs/PROFORMA-MAPPING.md) — how tool output maps back to the
  ESS spreadsheet.

## Scope & honesty

This automates the **desktop research** stage of an ESS. It flags gaps rather
than hiding them: a source that can't be reached is reported as *failed*, and one
that needs an interactive portal or internal login is reported as *manual* with
the aimed link and steps. A human delivery group still reviews and signs off the
final ESS per the Quick Reference Guide. Questions: `enviro@bom.gov.au`.
