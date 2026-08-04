# ESS Workbench

A tool that helps generate **Environmental Site Summaries (ESS)**  — pick a site by name (or drop in a latitude/longitude), and it
auto-populates the station metadata, opens every relevant environmental and
heritage source aimed at that location, runs the checks that can be automated,
and builds a report that flags **what was found, what was empty, and what
couldn't be checked**.

It has two halves that share the same data:

| Component | What it is | Runs where |
|-----------|-----------|-----------|
| **Browser tool** (`index.html`) | A static, single-page app. Station autofill, an auto-populated satellite locator map, deep-linked collection dashboard, live Atlas of Living Australia check, photo evidence (paste/drag/file-picker), and an exportable ESS report. | Any browser · GitHub Pages · offline |
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

The left pane is the workflow, numbered in the order you work it. Everything
belonging to another way of working — batches, file imports, the in-browser
agent, display preferences — is folded into **Advanced options** at the foot of
that pane, so the four steps are all you see until you go looking.

1. **Choose a site.** Type a station name/number, or switch to
   **By coordinates**. Once a site is open the picker folds away — **Change site**
   in the site header (or ① on the nav rail) brings it back.
2. **Check the site details.** At rest this is a header, not a control panel: the
   station name, number, state, delivery group and facility, the coordinates
   (click to copy), thumbnails of the two locator maps and the photo count, in
   about 130 px. **Details** opens the rest and remembers that choice — the full
   station record (station #, WMO, state, delivery group, facility, lat/long,
   replicating the workbook's VLOOKUP autofill), the assessment date and
   maintenance fields, the photo dropzone, and each map's radius presets, **Side
   km**, **Roads & labels** and **Refresh**. The two **satellite locator maps**
   are generated automatically with a pin on the station and are right by default;
   click a thumbnail to open the full-screen view. Add **station photos** by
   pasting from the clipboard **anywhere on the page** — with the panel shut, a
   pasted screenshot still lands on the site and bumps the count — or drag a file
   / use the picker inside the panel. The maps and photos travel with the report
   and every export.
3. **Run the checks** — the two automated passes, in one card so the round trip
   to an assistant never needs a scroll. It is a sequence, so only the sub-step
   you haven't done yet carries a filled button; a sub-step that has been run
   stands down to a one-line receipt of what it did (`✓ 12 live sources checked —
   3 found`) with its re-run one click away, and when all three are done the whole
   card folds to a single line, **Re-open** and all:
   * **Run auto-checks** answers every source with a public data API (Atlas of
     Living Australia, Queensland WildNet) live in your browser, and reports what
     it found next to the button.
   * **Copy prompt** copies a complete, self-contained prompt for this site.
     Paste it into any assistant (ChatGPT, Gemini, Claude, Copilot…).
   * **Paste its reply back here** takes the JSON the assistant returns — code
     fences and surrounding commentary and all — and fills the dashboard.
     Sources the reply leaves blank keep the result they already have, so the
     auto-checks you ran first are never undone.
4. **Finish & include each source.** On a first visit this step opens with a
   short **How to work through the list** guide; once you have finished a site —
   everything answered, or exported — it stops appearing and lives behind the
   **?** in that card's header. Each source card reads top to bottom in the
   order you form an opinion: **who it is** (number, tile, name — with **ⓘ** for
   what to look for, the jurisdiction and the link), then **what came back** (the
   source's own words, labelled and tinted to the result), then **your note**,
   then what you do about it — set a **Result** (Found / Nothing / Failed /
   Manual; the **ⓘ** beside it says how Result and sign-off relate), **Open the
   source ↗**, then **＋ Include**, and **Sign off** last. The **Report** line
   names the section this card feeds — press **change** if it belongs somewhere
   else. Including it confirms where it went (**✓ Added to Threatened Habitat**),
   and that name takes you straight there. Utilities you need occasionally — copy
   lat/long, web search, jump to the report, clear your note — are on the card's
   **⋯** menu.
   The list keeps itself short as you work: a card you've **signed off**
   settles to a single line, one that's answered but not yet signed off shows a
   short summary, and only the sources that still need you stay at full size and
   sort to the top of their category (**⇅ Source order** puts the registry
   order back). Click any collapsed card to open it again. Each category heading
   says what is inside it — `8 sources · 3 found · 4 need you` — and a category
   with nothing outstanding folds away to that one line.
   Sources for weeds, pests, disease, threatened species and biosecurity take
   evidence photos — press **＋ Add photo** for a drop / paste / pick zone (paste
   with Ctrl+V straight onto the card) and attach evidence when a check comes back
   **Found**. On the species cards (weeds, feral animals, disease, threatened
   species) the same panel lets you type a name and hit **🔎 Fetch image** to pull
   a labelled reference photo straight from Wikipedia — no hunting for one — with
   its licensing credit attached. Or hit **Reference image from notes** and the
   tool reads the species/subjects out of that card's findings text and fetches a
   photo for each; with **Auto-fetch reference images** on (Advanced options →
   Display options) this also happens automatically on **Import** and during
   agent runs.
   * The **EPBC PMST** card's **Open the source ↗** link bakes the site's lat/long into
     the URL, so the Protected Matters Search Tool loads straight onto the
     location with its export panel open. Draw the buffer, generate the **Excel**
     report, then click **Import PMST Excel** on the card: the tool reads the
     workbook entirely in your browser (no upload, no dependency) and renders the
     **Matters of National Environmental Significance** down to a text summary in
     the notes — heritage, Ramsar, GBRMP and marine areas in full; threatened
     **communities and species filtered to those recorded as "Known"** (Likely/May
     are counted but not listed). It also **drafts the Threatened Habitat / Flora /
     Fauna section narratives** from that split (communities → habitat, plants →
     flora, animals + migratory → fauna), so the report body reads like a
     hand-written one — without overwriting anything you've already typed.
   * At Queensland sites, the **Queensland Globe** card has an **Open site map**
     button. It opens a full interactive map of the site *inside the workbench* —
     Queensland aerial imagery drawn from the same government spatial services
     Queensland Globe itself uses, with the ESS environmental layer stack over it
     and **the station pinned**. Use it to sanity-check the position: pan and zoom
     around the pin and see what the layers actually show there. **Click anywhere
     on the map** and a popup lists every layer covering that exact point — with
     the feature's own details and the colour/pattern that layer is drawn with —
     so a shaded patch can be identified instead of guessed at. The left panel
     leads with **Picture for the report**, and below it lists ~60 layers in seven
     searchable groups (MSES, vegetation & habitat,
     protected places, wildlife habitat, water & wetlands, biodiversity
     assessments, reference & terrain) with per-group *All/None* toggles and three
     presets; your selection is remembered per site. Sublayer IDs are resolved
     against each service's live layer list at open time, so a layer that can't be
     found is struck through and named rather than silently missing, and a **Map
     diagnostics** panel says exactly which service worked. When the map looks
     right press **Capture map for the report** — one press takes the picture
     *and* puts it in the report, and the thumbnail below the button is your
     receipt. The picture goes on the card and travels through the report, HTML,
     JSON and Print/PDF exports — rendered **full width** and **clickable for a
     full-screen view**, on screen and in the exported HTML alike — and the **full
     layer list goes to Appendix A** of the report rather than cluttering the
     picture or the report body. Appendix A gives each layer a **legend box**
     showing the colour and pattern that layer was drawn with, taken from the
     service's own published symbology, so the map can still be read once the
     report is all anyone has. (The ordinary **Open the source ↗** link still opens Queensland
     Globe itself if you need its own tools or legend.)
5. The **ESS report** fills with the standardized proforma wording,
   your collection evidence, and any attached photos. It opens with a **document
   header** pinned to the top of the pane — the site, its station number, state,
   delivery group, coordinates and assessment date (WMO number, facility types
   and maintenance under **Details**), so the report always says which site it is
   for, however far down you have scrolled and whichever site a batch has just
   switched to. Beside that: **n of 11 sections reviewed** and a
   **consistency-warning count** that takes you to the first warning.
   Each section's evidence is grouped by what it actually is: **Findings** at full
   weight (the first three expanded, each note clamped to three lines with *Show
   all*), **Checked, nothing found** as a single line naming those sources, and
   **⚠ Not yet checked** — the interactive-only portals and failed searches — as a
   caveat, with every source name a jump back to its collection card. A section
   with one real result and four tools nobody has opened yet now says so.
   Each section has an
   **Insert suggested detail** button that drafts a paragraph from that
   section's evidence plus standard wording (`data/statements.json`), and the tool
   **flags contradictions** — a statement that says "no known…" while the evidence
   came back *Found*, a "matters present" statement with no supporting detail, or
   a section asserting a conclusion while some of its sources have not been
   checked.
   One **Export ▾** menu takes the report out of the app — **Print/PDF** (the
   handover format) first, then **HTML file**, **JSON export**, **Copy summary**;
   photos and review flags travel with the export (embedded, so the HTML/JSON stay
   self-contained), and the printed and exported reports carry the same
   findings / nothing-found / not-yet-checked split, so the person receiving the
   report sees the caveat too. Each section carries its own **Reviewed** tick, and where the
   sections end the report says what is still missing — sections with no statement,
   an empty comment, no included evidence or no review, each a shortcut to the
   first one. Next to it, **Check report** copies a
   precise fact-and-consistency-check prompt for that report — paste it into any
   assistant (ChatGPT, Gemini, Claude, Microsoft 365 Copilot…) for an independent
   review with a fixed, terse output structure (verdict · issues table · fact-check
   table · outstanding gaps).

Your work is saved in the browser (localStorage) per site, so you can come back
to it.

**What's left, in one place.** One bar pins to the top of the collection pane and
answers it: a two-part progress bar (answered / still needing you), the count in
words — *11 of 23 still need you* — and four segments that **are** the filter:
**Needs you · Answered · Signed off · All**. "Still need you" has a single
definition everywhere in the tool (Manual, Search failed, Not checked), so the bar,
the segments, the jump-rail badges and each category's roll-up can never disagree.
Per-result counts (and per-result filters) are one click away under **Results**,
and **⇅** at the right end switches the card order. Your choice of segment is
remembered per site. An import or an agent run lands the bar on **Needs you**
itself, so what's left is on screen without a banner having to say so.

**The two panes.** Collection is on the left, the report on the right, each
scrolling on its own. The collection bar stays pinned as you scroll — the report's
document header does the same on the right. The two small handles on the seam between the
panes **collapse one side and give the other the full width** (one at a time);
click the highlighted handle to bring the pane back. The choice is remembered.
The narrow **jump rail** on the far left carries the four steps plus one button
per source category, badged with how many sources in it still need a human.

**The two halves show you they belong together.** Hover (or tab to) a source card
and the report section it feeds lights up; hover a report section and every card
feeding it lights up — no scrolling, nothing moves. In the report, a source's
**name** is the way back to its card. The collection bar names any **report
sections with no evidence yet**, so you find an empty section from the side you
are collecting on rather than by scrolling the report. The third handle on the
seam (**⇄**) **links the two panes' scrolling** so each follows the other by
section; it is off until you turn it on, and then remembered.

### Let the agent do the collection

The `ess-collect` agent can research every source and fill the tool's dashboard
for you. Two ways to run it — both produce the same `ess-findings/1` object and
feed the same review/export surface (full guide: [docs/AGENT-MODE.md](docs/AGENT-MODE.md)):

- **File handoff (any LLM).** Load the site and click **Copy prompt** to copy
  a complete, self-contained, model-agnostic prompt; paste it into any assistant
  (ChatGPT, Gemini, Claude, Copilot…), then paste the JSON it returns straight
  into the **Paste its reply back here** box in the same step 3 card. No key in
  the browser.
  Best for batches. *(In a Claude Code session in this repo, the prompt's top
  note lets you run the `ess-collect` skill instead — same JSON — or just ask
  "Run an ESS for WOODGATE ALERT".)*
  * **Batches.** Two ways to start a batch. In the browser, open **Advanced
    options** at the foot of the left pane and click **Batch multiple sites**
    to pick a list — search-and-add
    stations, or paste names/numbers or `lat,lon[,name]`, one per line — and
    **Start batch**. Or scaffold them all outside the browser with
    `resolve.py --batch sites.txt --template` (same one-per-line format) — it
    emits one `ess-findings-batch/1` object (`{ sites: [ … ] }`) for an agent to
    fill and **Advanced options → Import a findings file** to load. Either way the tool shows a **batch
    picker bar**: one chip per site (with its found / still-needs-you counts,
    remembered across visits), each opening into the same review/export surface,
    plus a **Check all** button that copies one combined
    fact-and-consistency-check prompt covering every site. Ask a Claude Code
    session to "run an ESS for these sites: …" and it does the whole batch.
- **BYOK in-browser (beta).** In **Advanced options**, click **Agent
  mode…**, paste your **own** Anthropic
  API key, and **Run full assessment**. The browser drives Claude directly
  (Anthropic's server-side web search/fetch bypass CORS) and fills the dashboard
  live. The key stays in your browser; ~a few cents per site.

Either way, the tool then flags the **Manual** and **Failed** items still needing
a human (interactive portals, internal SharePoint), you finish those, and export.
See [`.claude/skills/ess-collect/SKILL.md`](.claude/skills/ess-collect/SKILL.md).

---

## Publish to GitHub Pages

The whole thing is static — no build step.

1. Push this repo (or merge to your default branch).
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch →
   `main` → `/ (root)`.** A `.nojekyll` file is included so every `data/` and
   `assets/` file serves as-is. GitHub's built-in builder publishes the repo
   root on each push to `main` — there is no custom workflow to maintain.
   *(Do **not** also add a "GitHub Actions" Pages workflow: running both the
   branch builder and an Actions deploy makes them race for the same
   deployment, and merges intermittently fail with "No artifacts named
   github-pages". Pick one source and leave it.)*
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
  dropdowns.json               Standardized proforma statement lists (build-generated)
  statements.json              Narrative templates (GBO, koala, duty-of-care…) — hand-authored
  reference/                   Weeds list, disease notes
  meta.json                    Build provenance (source hash, counts, date)
build/
  build_data.py                Refactors the workbook -> data/*.json
  source/                      (git-ignored) drop the raw workbook here
.claude/skills/ess-collect/    Agent skill: SKILL.md + resolve.py helper
docs/                          Architecture, roadmap, how to add a source, mapping
.nojekyll                      Serve data/ & assets/ as-is (Pages, no Jekyll)
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — how the pieces fit and the data model.
- [Roadmap](docs/ROADMAP.md) — what's built, what's next, the automation backlog.
- [Agent mode](docs/AGENT-MODE.md) — the file-handoff and BYOK in-browser agent
  paths, key handling, and cost.
- [Adding a source](docs/ADDING-A-SOURCE.md) — extend the registry (the main way
  this grows).
- [Proforma mapping](docs/PROFORMA-MAPPING.md) — how tool output maps back to the
  ESS spreadsheet, including the section narratives and consistency warnings.
- [Human ESS vs the workbench](docs/HUMAN-VS-WORKBENCH.md) — assessment of real
  staff-completed ESS documents against the tool, and the improvements it drove.

## Scope & honesty

This automates the **desktop research** stage of an ESS. It flags gaps rather
than hiding them: a source that can't be reached is reported as *failed*, and one
that needs an interactive portal or internal login is reported as *manual* with
the aimed link and steps. A human delivery group still reviews and signs off the
final ESS per the Quick Reference Guide. Questions: `enviro@bom.gov.au`.
