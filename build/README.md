# Data build

`build_data.py` refactors the BOM *FWIN ESS Template* workbook into the clean
JSON the tool and skill consume. Only the derived JSON (`data/`) is committed;
the raw workbook is git-ignored.

## Run

```bash
pip install -r requirements.txt
# place the workbook here (git-ignored):
#   build/source/FWIN_ESS_Template.xlsx
python build_data.py
# or:  python build_data.py --source /path/to/workbook.xlsx --out data
```

Outputs, into `data/`:
- `stations.json` — unioned, de-duplicated station list (minified web asset).
- `dropdowns.json` — standardized proforma statements per section.
- `reference/weeds.json`, `reference/diseases.json` — reference lists.
- `meta.json` — provenance: source filename + SHA-256, counts by state/facility,
  build timestamp.

Output is sorted and deterministic, so re-running after a workbook update yields
a clean, reviewable `git diff`.

## What it does

- **Unions every station-bearing tab.** No single tab is complete — the broad
  `EAMS DATA SET` export omits ~315 Flood Warning Network sites (e.g. WOODGATE
  ALERT / 539251) that exist only in the `Station Data Sheet` autofill list. The
  build merges EAMS → the FWN list → the categorised tabs, keyed by station
  number, filling blanks from later tabs and unioning facility types.
- **Normalises state** (`TAS/ANT`→`TAS`; `HO`/coordinate-only → inferred from a
  bounding box) and attaches per-state reference links.
- Header tabs (`EAMS DATA SET`, `Station Data Sheet`) are parsed by column label;
  the categorised tabs have no header row and use the fixed column maps in
  `HEADERLESS_LAYOUTS`.

## Auto Fill Information cell-range map

`build_dropdowns()` reads column **D** of the `Auto Fill Information` tab; ranges
mirror the proforma's x14 data-validation lists:

| Dropdown key | Range | Proforma cell it validates |
|---|---|---|
| `permits` | D3:D6 | A14 |
| `biosecurity` | D9:D11 | A18 |
| `threatened_habitat` | D22:D24 | A25 |
| `threatened_flora` | D25:D27 | A29 |
| `threatened_fauna` | D28:D30 | A33 |
| `diseases` | D31:D32 | A53 |
| `indigenous_areas` | D36:D37 | A37 |
| `heritage` | D39:D40 | A39 |
| `invasive_plants` | D45:D47 | A44 |
| `invasive_animals` | D48:D50 | A49 |
| `biosecurity_detail` | B/C 15,17,19 | A19 (IFS expansion) |

If a future template moves these, update the ranges in `build_dropdowns()`.

## Adjusting coverage

To publish a narrower station list (e.g. FWN only), filter inside
`build_stations()` on `facility_types` / `region` before writing. See Phase 1 in
[../docs/ROADMAP.md](../docs/ROADMAP.md).

## Supplemental merge: FReD (`merge_fred_stations.py`)

FReD is the Bureau's FWIN Register e-Database export — it lists partner/council
sites under assessment that are frequently missing from the ESS Template
workbook. `merge_fred_stations.py` unions a FReD export into the already-built
`data/stations.json`, adding any station whose number (and name+state) isn't
already present.

FReD has no lat/lon column. Coordinates are backfilled, where unambiguous, from
a second station list — a "MegaNet" radio-planning database whose station
names are truncated to 20 characters (a Radio Mobile field limit). A FReD name
truncated to 20 chars either matches a MegaNet name exactly or it doesn't;
matches that resolve to more than one distinct coordinate pair are treated as
ambiguous and left blank rather than guessed. Stations added without
coordinates still show up in the tool's station search — picking one prompts
for lat/lon via the "By coordinates" tab instead of silently producing broken
deep-links.

```bash
# Drop the exports into build/source/ (git-ignored, same as the workbook):
#   build/source/FReD.csv
#   build/source/meganet_stations.json   (optional — enables coordinate backfill)
python build/merge_fred_stations.py
```

Re-run whenever FReD is re-exported. It updates `data/stations.json` in place
and appends a provenance entry (counts, source hash) to `data/meta.json`'s
`supplemental_merges` list — run it *after* `build_data.py` if you're also
refreshing from a new workbook, since `build_data.py` fully regenerates
`stations.json` from scratch.
