---
name: ess-collect
description: >-
  Run the desktop assessment for a Bureau of Meteorology Environmental Site
  Summary (ESS) at a given site — chosen by station name/number or by
  latitude/longitude. Resolves the station's metadata, works through every
  applicable environmental & heritage source (EPBC PMST, Atlas of Living
  Australia, state biodiversity/heritage tools, invasive species, disease
  outbreaks, PFAS, acid sulfate soils), and produces a findings report that
  flags FOUND / NOTHING FOUND / SEARCH FAILED / MANUAL for each source. Use when
  the user asks to "do an ESS", "assess a site", "collect environmental
  metadata for a location", or "generate an ESS report" for a lat/long or a
  named Bureau station.
---

# ESS desktop assessment (ess-collect)

You are completing the **desktop research** stage of a Bureau of Meteorology
Environmental Site Summary (ESS): a concise summary of the environmental and
heritage matters to consider before someone attends a site and does work.

Your job is to take a site (a named station or a lat/long), check every relevant
source, and produce a report that records **what was found, what was empty, and
what could not be checked** — one explicit status per source. This mirrors the
ESS proforma in the FWIN ESS Template workbook.

The companion browser tool (`index.html`) does the same thing interactively.
Both read the same data files, so your output is interchangeable with it.

## Status taxonomy — use exactly these four

Every source must end with one status. This is the whole point of the exercise.

| Status | When to use it |
|--------|----------------|
| **FOUND** | The source returned something relevant to record (a listed species, a heritage place, an outbreak zone, a lease condition, a PFAS site…). |
| **NONE** | You successfully checked the source and it returned nothing relevant. *Successfully checked* is the key part — you saw the result. |
| **FAILED** | You tried but could not get an answer: the site was unreachable, blocked by CORS/network/egress policy, timed out, or returned an error. Never silently drop these — a failed check is a real, reportable outcome. |
| **MANUAL** | The source cannot be assessed programmatically (interactive map with no API, draw-a-polygon report tool, internal SharePoint needing login). Provide the aimed deep-link and the exact steps a human must take. |

Distinguishing NONE from FAILED matters: "nothing is there" and "we don't know"
are different risk positions. Do not collapse them.

## Step 1 — Resolve the site and its source list

Run the deterministic helper. It resolves the station against
`data/stations.json`, picks the state, and prints every applicable source with
its deep-link already aimed at the coordinates.

```bash
# by name or station number
python .claude/skills/ess-collect/resolve.py --station "WOODGATE ALERT"
python .claude/skills/ess-collect/resolve.py --station 539251

# by coordinates (state auto-detected; override with --state)
python .claude/skills/ess-collect/resolve.py --lat -25.0891 --lon 152.5489 --name "My site"

# add --json for a machine-readable payload (site + sources + epbc_matters + dropdowns)
python .claude/skills/ess-collect/resolve.py --station "WOODGATE ALERT" --json

# --template prints the empty ess-findings/1 skeleton you will fill in (see Step 3)
python .claude/skills/ess-collect/resolve.py --station "WOODGATE ALERT" --template
```

The site block it prints is the ESS header (station number, WMO, state, delivery
group, facility, lat/long) — reproduce it at the top of your report. If a name
matches several sites, it tells you on stderr; confirm the right one with the
user if it's ambiguous.

## Step 2 — Work through every source

Go through the list the helper printed. Handle each by its `method`:

- **`api`** — query it and parse the result. Currently the Atlas of Living
  Australia (see the recipe below). Set FOUND / NONE from the data, or FAILED if
  the request errors.
- **`web_search` present** — run that search (WebSearch/WebFetch). Use it to
  answer the source's "what to find". Record specifics (species names, listing
  numbers, outbreak names), not just "yes/no".
- **`deep_link`** — open/fetch the URL. If it's a static page you can read
  (agency overview, weeds list), extract what's relevant → FOUND/NONE. If it's
  an interactive map with no readable data at that URL → MANUAL with the aimed
  link.
- **`manual`** — these need a human (interactive GIS portal, or internal
  SharePoint marked `INTERNAL`). Still do a best-effort web search to surface
  anything public (e.g. a heritage place name), but the definitive check is
  MANUAL. Always include the aimed deep-link and the steps.

Do not skip a source because it looks hard. If you cannot check it, that is a
MANUAL or FAILED result — record it, with the link and the reason.

### The EPBC Protected Matters Search Tool (always MANUAL)

`pmst.environment.gov.au` has **no public API** — it is a draw-a-polygon report
generator. Always record it as MANUAL, with the buffer and the steps:

1. Locate the site (lat/long is most specific).
2. Draw a square around it (LHS *Draw*).
3. LHS *Report* → select box 1.
4. Buffer = **50 km** → *Explore*.
5. *Generate report* (bottom RHS) — Excel is easiest (sort by known vs likely
   and IUCN status).

Check these matters (from `epbc_matters` in the payload): protected areas
(terrestrial & marine), Ramsar wetlands, World / National / Commonwealth
heritage places, Great Barrier Reef Marine Park, Australian Marine Parks, listed
critical habitat. The Atlas of Living Australia check (below) corroborates the
species side of this and *can* be automated, so run it and cite it.

### Atlas of Living Australia — the one live API

Endpoint: `https://biocache-ws.ala.org.au/ws/occurrences/search`
(CORS-enabled; may be blocked by a restricted agent egress policy — if so, that
is a FAILED result and the user should run the browser tool, which calls it from
their own browser).

```
# A) headline — total records + conservation-status classes within 10 km
GET .../search?q=*:*&lat={lat}&lon={lon}&radius=10&pageSize=0&facets=stateConservation,countryConservation

# B) the actual listed species (only if A shows conservation facets)
GET .../search?q=*:*&fq=(stateConservation:*+OR+countryConservation:*)&lat={lat}&lon={lon}&radius=10&pageSize=0&facets=species&flimit=40
```

Read `totalRecords` and `facetResults`. Interpretation:
- conservation facets present (Vulnerable/Endangered/…) → **FOUND**; list the
  species from call B and their status classes.
- records present but no conservation facets → **NONE** (surveyed, nothing
  listed) — still corroborate with PMST + state tools.
- zero records → **NONE**, but note the area is sparsely surveyed (absence of
  records ≠ absence of species).
- request errors → **FAILED**.

## Step 3 — Produce the findings

You must produce **two** things: the machine-readable findings object (so it
imports straight into the browser tool) and a short human-readable summary.

### 3a. The findings JSON (required, `ess-findings/1`)

Run `resolve.py --template` to get the empty skeleton, then fill it in — it is
the same schema the browser tool imports and exports, so a filled template drops
straight into **Import agent findings** for review and export:

```
python .claude/skills/ess-collect/resolve.py --station "WOODGATE ALERT" --template > findings.json
```

The skeleton already has the `site` block, every applicable source pre-listed in
`collection_log` (with `status:"unset"`), and every proforma `section`. Your job:

- For **each `collection_log` entry**: set `status` to `found` / `none` /
  `failed` / `manual`, put the specifics in `note` (species names, listing IDs,
  outbreak names, lease conditions), and — for anything you actually queried —
  the raw result in `result_text`. Never leave a source `unset`.
- For **species/subject entries** (invasive plants, invasive animals, disease,
  threatened — they have an `image_subjects` array in the skeleton) that you mark
  `found`: list the identifiable species/subject names in `image_subjects`
  (common or scientific, e.g. `["Gamba grass", "Phytophthora cinnamomi"]`). On
  import the browser tool auto-fetches a labelled Wikipedia reference photo for
  each, so a reviewer sees what they're looking for. Leave it `[]` for
  none/failed/manual or where you can't name the subject.
- For **each `section`**: set `choice` to the exact standardized statement from
  `data/dropdowns.json`, and write a real **narrative** in `note` (see 3c — this
  is what makes the output match a human's, not just a one-line verdict). For the
  `biosecurity` section, put the declaration text (from
  `dropdowns.json.biosecurity_detail`) in `detail`.

Emit the completed object as a fenced ```json block (and/or write it to a file)
so it can be copied into the tool verbatim.

### 3c. Writing the section narratives (match the human depth)

A good ESS section is a short paragraph, not a single sentence. Reusable
standardized wording lives in **`data/statements.json`** (GBO text per state, the
impact-assessment sentence, the koala-district note, duty-of-care, the migratory
note). Use it. The browser tool auto-drafts these on PMST import and via the
"Insert suggested detail" button; when you run headless, write them yourself:

- **Threatened Habitat / Flora / Fauna** — split the PMST result across the three
  sections the way the samples do. Habitat ← threatened ecological communities;
  Flora ← threatened *plants*; Fauna ← threatened *animals*. Group by category
  (Critically Endangered → Endangered → Vulnerable) and name the species. Close
  flora/fauna with the impact-assessment sentence
  (`statements.json.impact_boilerplate`). Put **listed migratory species** in a
  sentence of their own — they are a *separate* matter of NES, not "threatened".
- **Choice wording — read the buffer.** A PMST/ALA result over a 50 km buffer
  speaks to the *wider region*, so choose the **"…found in the local area"** option
  (the third in each list), **not** "…at this site", unless you have an on-site
  record. This is the single most common human error (see below).
- **Koala (QLD)** — when a koala is among the fauna, add the Koala Conservation
  Plan note and link from `statements.json.koala` (districts A/B cover South East
  Queensland; the rest of the State is district C, where the sequential clearing
  rules do not apply).
- **Additional Information** — add the General Biosecurity Obligation paragraph for
  the **site's state** (`statements.json.general_biosecurity_obligation[STATE]`).
  Only mention acid sulfate soils if the acid-sulfate-soils source actually
  indicates they are likely (coastal/estuarine, low-lying) — do **not** assert it
  for inland/upland sites.
- **Invasive Plants / Animals** — resolve the **actual local council / region** for
  the site and list *its* priority/declared species with the council's link. Do
  not paste another region's list.
- **Indigenous Protected Areas & Heritage** — name the Traditional Owner group and
  any contact where you can identify it, and add the cultural-heritage duty-of-care
  sentence (`statements.json.duty_of_care`).

### Common mistakes to avoid (seen in real staff-completed ESS)

1. **Never let the standardized statement contradict the evidence.** If you write a
   paragraph listing found species, the statement must not say "There are no
   known…". The browser tool flags this; you should not produce it.
2. **Do not paste another region's council content.** Confirm the council/region
   that actually contains the site before listing weeds/pests.
3. **Do not assert acid sulfate soils** (or any generic hazard) without a source.
4. **Do not file migratory species under threatened fauna** — they are separate.
5. Prefer "…in the local area" over "…at this site" for buffer-based findings.

### 3b. The human summary (required)

A tight Markdown recap:

1. **Header** — the resolved site block (name, station #, WMO, state, delivery
   group, facility, lat/long, assessment date).
2. **Section findings**, in proforma order, each a one-line finding + the chosen
   standardized statement.
3. **Collection log** — a table of every source: name · status
   (FOUND/NONE/FAILED/MANUAL) · evidence or reason · link.
4. **Outstanding manual checks** — bullet the MANUAL/FAILED items with their
   aimed links so a human can finish them in the browser tool (PMST report,
   internal SharePoint, interactive GIS portals).

### Suggesting the standardized statements

`data/dropdowns.json` holds the exact proforma wording per section. The lists are
ordered `[no known…, known…/at-site, …local area]`. Pick the "known" option when
the relevant checks were FOUND, otherwise the "no known" option. For Biosecurity,
`biosecurity_detail` maps the chosen level to its full declaration text.

## Honesty rules

- Never present a MANUAL or FAILED source as if it were checked. The value of an
  ESS is that the gaps are visible.
- Record specifics you actually found (names, numbers, dates), not paraphrase.
- If egress/network blocks a source, say so plainly and point the user to the
  browser tool, which runs the live checks from their own browser.
- The desktop assessment is the input to an ESS; a human delivery group still
  reviews and signs off (see the QRG). Do not imply final approval.

## Extending

Sources live in `data/sources.json` — add an object and it appears here and in
the browser tool automatically. See `docs/ADDING-A-SOURCE.md`. If a source gains
a real API, set `method: "api"` and add an `api` block, then teach this skill
(and `assets/app.js`) how to call that `api.kind`.
