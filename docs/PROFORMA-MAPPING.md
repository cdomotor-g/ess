# Proforma mapping

How the ESS proforma (the `ESS Proforma` sheet in the FWIN ESS Template) maps to
this tool. Cell references are from that sheet.

## Header autofill (replicated exactly)

In the workbook, you pick a station name in **D3** and the rest fill by VLOOKUP
against the `Station Data Sheet`:

| Proforma cell | Field | Workbook source | Tool source |
|---|---|---|---|
| D3 | Station Name | dropdown (list) | station picker |
| D4 | Station Number | `VLOOKUP(…,4)` | `stations.json.station_num` |
| D5 | WMO Number | `VLOOKUP(…,5)` | `stations.json.wmo` |
| D6 | State | `VLOOKUP(…,2)` | `stations.json.state` |
| D7 | Delivery Group | `VLOOKUP(…,3)` | `stations.json.delivery_group` |
| D8 | Facility Name | `VLOOKUP(…,6)` | `stations.json.facility_types` |
| D9 | Latitude | `VLOOKUP(…,7)` | `stations.json.lat` |
| D10 | Longitude | `VLOOKUP(…,8)` | `stations.json.lon` |
| C11 | Site maintenance | *manual* | editable field (not auto-filled, per QRG) |
| A2 | Date | *manual* | assessment date field |

The proforma's invasive/disease **hyperlinks** (`A43`, `A48`, `A54`) come from
`Station Data Sheet` columns 11–13. Those are reproduced as
`stations.json.refs.{invasive_plants, invasive_animals, diseases}` and shown in
the report's Invasive Plants / Invasive Animals / Diseases sections. Where the
workbook stored a non-URL label (e.g. the QLD weeds cell), the tool substitutes
the real agency URL.

## Section → dropdown → sources

Each proforma section has a data-validation dropdown (standardized wording) and a
free-text box. The wording lists are extracted verbatim into `dropdowns.json`;
the sources that inform each section are tagged with the matching `category` in
`sources.json`.

| Proforma section | `dropdowns.json` key | `sources.json` category | Key sources |
|---|---|---|---|
| Permits and permissions | `permits` | `permits` | Permits register (internal) |
| Biosecurity | `biosecurity` (+ `biosecurity_detail`) | `biosecurity` | POPE / leasing (internal) |
| Threatened Habitat | `threatened_habitat` | `threatened` | EPBC PMST, ALA, state biodiversity |
| Threatened Flora | `threatened_flora` | `threatened` | EPBC PMST, ALA, PlantNET/WildNet/NatureMap |
| Threatened Fauna | `threatened_fauna` | `threatened` | EPBC PMST, ALA, BioNet/WildNet |
| Indigenous Protected Areas | `indigenous_areas` | `indigenous_heritage` | IPA (DCCEEW), NIAA map, ACHIS |
| Heritage Considerations | `heritage` | `indigenous_heritage` | Australian + state heritage registers |
| Invasive Plants | `invasive_plants` | `invasive_plants` | state weeds references |
| Invasive Animals | `invasive_animals` | `invasive_animals` | DCCEEW invasive species |
| Diseases and Pathogens | `diseases` | `disease` | OUTBREAK |
| Additional Information | *(free text)* | `additional` | PFAS map, acid sulfate soils, locality search |

### Suggesting the right statement
Each dropdown list is ordered `[no known…, known…/at-site, …local area]`. The
tools suggest the **"known"** option when the section's sources came back *Found*,
otherwise the **"no known"** option. The user/agent can override. Example
(Threatened Flora): ALA returns listed plants → suggest *"There are known
threatened plants at this site"*; nothing found → *"There are no known threatened
plants at this site"*.

On **PMST import**, the threatened sections are suggested the **"…in the local
area"** option instead — a 50 km Protected Matters buffer speaks to the wider
region, not the footprint. (Human sheets routinely over-claim "…at this site"
here; see [HUMAN-VS-WORKBENCH.md](HUMAN-VS-WORKBENCH.md).)

### Section narratives (`data/statements.json`)
The proforma sections carry a paragraph, not just the one-line statement. The tool
drafts those paragraphs:

- **PMST import** splits the Matters of NES across **Threatened Habitat**
  (ecological communities), **Threatened Flora** (threatened plants) and
  **Threatened Fauna** (threatened animals + a separate migratory sentence),
  grouped by category, and seeds each section's note — only where the reviewer
  hasn't already written it.
- **"Insert suggested detail"** on every section assembles a default paragraph
  from that section's evidence plus standardized wording in **`data/statements.json`**
  (hand-authored, not build-generated): the impact-assessment sentence, the QLD
  Koala Conservation Plan note + link, an acid-sulfate note under Additional
  Information (only when that source is *Found*), and the cultural-heritage
  duty-of-care sentence. The per-state **General Biosecurity Obligation** paragraph
  is seeded straight into the **Biosecurity** section note when a site is first
  opened (`defaultSectionNote`), so it isn't repeated by the button.

### Consistency warnings (QA)
The report flags the mistakes the human sheets are full of: a standardized
statement that **contradicts its evidence** (says "no known…" while sources came
back *Found* or the note lists species), and a "matters present" statement left
with **no supporting detail**. Warnings show on-screen and as review flags in the
Print/HTML export and the JSON (`sections[].warnings`).

### Biosecurity declaration text
The proforma's biosecurity cell (`A19`) uses an `IFS` to expand the chosen level
into full declaration text. That mapping is preserved in
`dropdowns.json.biosecurity_detail` (General clean / Biosecurity declaration /
Washdown and Virkon treatment → their paragraphs), and the report renders the
matching text under the chosen level.

## What the tool adds beyond the proforma

- A **collection log**: every source checked, with an explicit
  Found/None/Failed/Manual status and a link. The proforma records conclusions;
  this records the evidence and the gaps behind them.
- **Photo evidence**: a general station photo gallery, plus per-source photos
  on weed/pest/disease/threatened-species/biosecurity sources — pasted, dragged
  or picked in the browser and carried through to every export.
- **Coordinate entry** for sites not in the station list.
- **Deep-links aimed at the site** and one **live check** (ALA), so the
  conclusions are faster to reach and easier to justify.

## Toward replacing the proforma

The JSON findings export already contains everything the proforma header + the
section dropdowns + notes need. See Phase 3 in [ROADMAP.md](ROADMAP.md) for
writing a filled `.xlsx`/PDF directly from that object.
