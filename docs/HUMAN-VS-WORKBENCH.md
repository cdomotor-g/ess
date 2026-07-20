# Human ESS documents vs the ESS Workbench

An assessment of three real, staff-completed FWIN ESS workbooks against what this
tool produces, and the improvements made so the tool's output is as good as — or
better than — the human work.

The three samples:

| Workbook | Sites | Region |
|---|---|---|
| `FWIN ESS – Rainfall retrofit – Condamine River` | 15 alert sites | Western Downs / Southern Downs, QLD |
| `FWIN ESS – Water Level – Macintyre River` | 2 sites (Texas TM, Dalcouth) | Goondiwindi / border, QLD |
| `FWIN ESS – Herbert Feb 26` | 3 sites (Ben Avon, Extended Range, Wooroora) | Hinchinbrook / Herbert, QLD |

All three are the same **FWIN ESS Template** this tool was refactored from: one
proforma sheet per site, plus the shared reference tabs (Station Data Sheet, Auto
Fill Information, Weeds, Diseases, EAMS data, …). The proforma sheet is exactly the
layout the tool mirrors: header block (rows 1–11), then Permits, Biosecurity,
Additional Information, Threatened Habitat/Flora/Fauna, Indigenous Protected Areas
& Heritage, Heritage, Invasive Plants/Animals, Diseases.

---

## 1. What the humans do well (and the tool should match)

The human sheets are strong in one dimension the tool was weak in: **each section
carries a real narrative paragraph**, not just a one-line verdict. Specifically:

1. **Threatened Habitat / Flora / Fauna narrative from the PMST.** Every site has a
   written paragraph splitting the Protected Matters result into TECs (habitat),
   flora, and fauna, with the conservation categories (Critically Endangered /
   Endangered / Vulnerable) and named species, closing with an impact-assessment
   sentence ("the site is cleared/disturbed … no impact expected").
2. **Koala district determination** (QLD) with the Koala Conservation Plan
   paragraph and the DES clearing-requirements link (`A35`/`A36`).
3. **General Biosecurity Obligation paragraph** under Additional Information — the
   QLD *Biosecurity Act 2014* GBO text, plus an acid-sulfate-soils mention.
4. **Council/region-specific invasive plants and animals** — a named priority-weeds
   and priority-pest-animals list tied to the local council's biosecurity plan,
   with the council link.
5. **Indigenous & heritage narrative** — Traditional Owner group named where known,
   a contact number, and a cultural-heritage duty-of-care sentence.
6. **Permit notes** — e.g. "contact the land owner 5 days prior to installation".

Items 1–5 are genuine content the tool did not generate on its own. Closing that
gap is the bulk of the improvement work below.

---

## 2. Where the humans got it wrong (do **not** treat as gospel)

The samples contain repeated, systematic mistakes. These are exactly the failure
modes an automated tool should avoid — and, better, actively catch.

### 2a. Verdict ↔ evidence contradictions (pervasive)
The one-line "standardized statement" (the dropdown) repeatedly contradicts the
paragraph directly beneath it:

- **Macintyre (Texas TM & Dalcouth):** habitat verdict = *"Threatened Habitat
  communities are found in the local area"*, but the paragraph says *"A Protected
  Matters search identified **no known TEC** in the broader community."* Verdict
  says found; evidence says none.
- **Herbert (Ben Avon):** flora verdict = *"There are known threatened plants at
  this site"*, but the paragraph opens *"Although **no threatened plant species
  have been officially recorded** in the area …"*. Direct contradiction.
- **Herbert (Extended Range & Wooroora):** invasive-plants verdict = *"There are no
  known invasive plants at this site"* sitting directly above a **six-species
  priority-weed list** for the Hinchinbrook region. The identical list on the Ben
  Avon sheet is labelled *"Invasive plants are found in the local area"* — the same
  evidence, opposite verdicts, in one workbook.
- The flora/fauna "…**at this site**" verdict is routinely chosen even though the
  paragraph argues the species are **unlikely to occur within the site footprint**.
  By the authors' own reasoning the correct verdict is "…in the local area".

### 2b. Wrong region copy-pasted in
The **Macintyre** sites (Texas / Dalcouth, on the Goondiwindi–NSW border) carry
**Bundaberg Region** invasive-plants and invasive-animals text —
*"targeted for control in the Bundaberg Region"*, *"Bundaberg Regional Council"*,
*"Invasive Animals in the Bundaberg region"*. Bundaberg is ~400 km away and a
different council entirely. The content was pasted from an unrelated ESS and never
localised.

### 2c. Field placement drifts between sheet variants
The workbook has two proforma layouts (a 15-column variant ending row 59, and an
8-column variant ending row 58). Between them the same logical field lands at
**different cell addresses**: heritage verdict is `A41`/`A42` in one and
`A40`/`A41` in the other; the invasive-section reference links sometimes sit
*above* the verdict (`A50`) and sometimes *below* (`A53`), and one cell holds a
plain label (*"Invasive Animals in the Bundaberg region"*) where a URL belongs.
Anyone parsing these by cell reference gets inconsistent data.

### 2d. Generic claims asserted without checking
*"Acid Sulfate Soils may be found in the area"* is appended to inland granite-belt
sites (Dalveen, Cherrabah — ~800 m elevation). Acid sulfate soils are a
coastal/estuarine phenomenon; at those sites the statement is effectively always
wrong. One sheet (Wooroora) silently drops the line — so it is inconsistent as
well as unsupported.

### 2e. Category and hygiene issues
- **Migratory species** (a *separate* EPBC matter of NES) are folded into the
  Threatened Fauna paragraph.
- Large paragraphs are duplicated verbatim across unrelated sites.
- Frequent typos in the final document (*"Endengered"*, *"woddlands"*,
  *"underHinchinbrook"*, *"Burtterfly"*).

---

## 3. Where the tool already beats the humans

- **An explicit collection log** — every source checked, each with a
  Found / Nothing-found / Search-failed / Manual status and a link. The human
  sheets record conclusions but not the evidence trail or the gaps behind them.
- **Rigorous PMST "Known-only" filtering.** The importer reads the PMST Excel and
  lists threatened communities/species/migratory recorded as *Known*, counting
  (but not listing) Likely/May. This is precisely the known-vs-likely discipline
  the humans kept getting wrong by hand.
- **Consistent, data-driven section placement** — no cell drift.
- **Geographic state resolution**, coordinate entry, deep links aimed at the
  site, an auto-generated satellite locator map, and licensed reference photos.
- **Reproducible and honest** — a source that can't be reached is reported as
  *failed*, and one needing a portal/login as *manual*, rather than quietly
  asserted.

The tool's weakness was **narrative depth**; its strength is **rigour and
traceability**. The improvements keep the rigour and add the narrative.

---

## 4. Improvements made

See `CHANGELOG` in the commit, but in summary:

1. **PMST import now writes the section narrative, not just the card note.** On
   import it seeds the **Threatened Habitat**, **Threatened Flora** and
   **Threatened Fauna** section notes with the split, category-broken-down
   narrative (and sets each section's standardized statement from *that section's*
   own Known findings). This replicates the humans' core paragraphs — and does the
   known-vs-likely split correctly. Migratory species are summarised as the
   separate matter they are.
2. **"Insert suggested detail" on every section.** Each report section can now
   assemble a default paragraph from its evidence plus standardized wording
   (`data/statements.json`): the impact-assessment closing sentence, the QLD Koala
   Conservation Plan note + link when a koala is among the fauna, the General
   Biosecurity Obligation paragraph (per state) and acid-sulfate note under
   Additional Information, and the cultural-heritage duty-of-care sentence. It is
   non-destructive — it fills an empty note or appends below existing text.
3. **Consistency warnings — catching the humans' #1 mistake.** The report flags a
   section whose chosen statement contradicts its evidence (e.g. verdict says
   "no known…" while sources came back *Found* or the note lists species), and a
   "found/known" section left with no supporting detail. These are surfaced in the
   tool and noted in the export.
4. **`data/statements.json`** — a new, durable (not build-generated) home for the
   standardized narrative templates: GBO text per state, duty-of-care, the
   impact-assessment boilerplate, the migratory note, the acid-sulfate note, and
   the Koala Conservation Plan district logic + link.
5. **Agent skill upgraded.** `ess-collect` now instructs the agent to write the
   richer per-section narratives, split the PMST across the three sections,
   determine the koala district and cite the plan, resolve the **actual local
   council** for invasive plants/animals (avoiding the Bundaberg-into-Macintyre
   error), and apply the QA rules — never letting the standardized statement
   contradict the evidence.

The net effect: the tool now produces the paragraphs the humans write by hand,
sourced from the same PMST evidence, while keeping its collection log and its
known-vs-likely discipline — and it warns on the contradictions the human sheets
are full of.
