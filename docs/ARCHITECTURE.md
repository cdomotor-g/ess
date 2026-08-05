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
  its coordinate-aimed deep-link. A card is laid out in **three zones, in the
  order an opinion forms** (`renderSourceCard`): **identity** (number, monogram,
  name, and an `ⓘ` disclosure holding the jurisdiction/method tags, the static
  "what to look for" prose, the steps and the URL) → **finding** (`result_text`
  first, labelled *What came back* and tinted to the result, clamped to four
  lines with a measured *Show all*; then the operator's own note, sized to its
  content; then evidence photos behind a compact **＋ Add photo**) →
  **disposition** (record the result → open the source → route it to a report
  section → **✓ Sign off**, last control on the card in DOM and visual order).
  The result is stated **once** on a resting card: the recorded value is a chip
  that expands back into the four-way picker on click, and an unanswered card
  shows the picker outright, since answering it is that card's whole job.
  Occasional utilities (copy lat/long, web search, jump to the report, clear the
  note) are in a per-card `⋯` menu. Everything behind `ⓘ`, `⋯` and `＋ Add photo`
  is **built on first open**, so 23 cards cost 23 buttons rather than 23 copies
  of prose and tooling nobody has asked for yet;
- renders each card at **one of three densities, derived from its state** and
  never from what has been clicked (`cardDensity`): a **signed-off** card is one
  ~36 px line (number, result glyph, name, target section, tick), an **answered
  but not signed off** card is a ~120 px summary (identity, two lines of the
  finding or the operator's note, the result, and the sign-off), and anything a
  human still owns — *Manual*, *Search failed*, *Not checked* — renders in full.
  Clicking a collapsed card opens it in place; that expansion is transient, so
  the next full render returns the pane to a picture of state rather than of
  click history. Within a category, cards sort **attention first**
  (unset → failed → manual → found → none → signed off) unless the operator
  flips the collection bar's `⇅` toggle to source order (remembered per
  browser). Each category header carries its own roll-up — `n sources · n found
  · n need you` — and a category with nothing outstanding folds to that header;
  the per-category open/closed choice is remembered per site;
- answers **"what still needs me" exactly once**, from one sticky control
  (`renderCollectionStatus`, `#collection-status`) that replaced a six-pill
  progress card, an attention banner and a six-button filter row. "Still needs
  you" has a single definition — `ATTENTION = manual | failed | unset`, applied
  through `isOutstanding` — and the progress bar, the four filter segments, the
  jump-rail badges and the group roll-ups all count with it, so the pane can no
  longer read *100% checked* and *11 still need you* at the same time. The
  segments **are** the filter: `state.filter` is a single value out of `FILTERS`
  (`attention` / `answered` / `signed` / `all`, plus the five per-result values
  behind the bar's `Results` disclosure), each rendered with `aria-pressed`, and
  it is **persisted per site** in the save payload's `ui.filter`. The count sits
  in a `role="status"` element and is only rewritten when the sentence changes,
  so a screen reader hears the outstanding count move and nothing else. An import
  or an agent run leaves the bar on `Needs you` (`focusOnOutstanding`) — the job
  the banner used to do, done by the control that already answers the question;
- keeps the **two "done" tallies apart**. The card's is a **sign-off** — a
  pressed pill (`.signoff`, `aria-pressed`) reading *Sign off* / *✓ Signed off*;
  the report section's is a **checkbox** (`.review-toggle`) reading *Mark section
  reviewed*. Different word, different control, different shape: they were
  previously the same `.review-toggle` with the same label in both panes. The one
  piece of vocabulary that needs explaining — a *Found* result is not good news,
  and sign-off is a separate judgement — is a `ⓘ` disclosure on each card's
  **Result** label rather than a paragraph in the instruction block;
- tiers every action, in **four weights defined once** in `styles.css`:
  `.primary` (filled, **at most one visible per surface**), `.secondary`
  (outlined — the bare `.btn`), `.tertiary` (text weight, no border) and the
  `⋯` / `More ▾` **overflow** menus. `.tiny` is a size, not a tier. A source
  card's one primary is **Open the source ↗** — what the operator opened the card
  to do; the specialist tools that appear on one to three cards in an assessment
  (*Open site map*, *Check live*, *Import PMST Excel*) are secondary, and the
  rare or recoverable utilities are in the card's `⋯`, where *Clear my note* is
  ruled off and coloured as destructive. Step ③ is a sequence, so only its **next
  un-run sub-step** carries a filled button (`syncFlowSteps`, `state.flow`,
  persisted per site in `ui.flow`); a sub-step that has been done swaps its
  letter for a ✓ and demotes, but is never disabled. The report header's one
  primary is **Export ▾** — a single menu holding every way the report leaves the
  app, handover format (Print/PDF) first; *Check report* copies a review prompt
  rather than exporting anything, so it sits with the report's own review
  controls at the foot of that pane. Both overflow menus share one implementation
  and one set of keys — ↑/↓, Home/End, and `Esc` to close and hand focus back to
  the trigger;
- writes buttons as **text, not pictographs**. A button carrying a text label
  carries no emoji; what remains is the monochrome mark language shared with the
  status dots and carets (`✓ ▾ ⋯ ↗ ⓘ ＋`), plus the handful of places where the
  glyph *is* the label — the category rail's monograms, the `📷` drop zone, the
  `📄` empty report. Nine unrelated pictographs on buttons had become a second,
  undocumented icon language competing with the category monograms and the
  status colours;
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
  into the report + exports. The stitched image is square (`MAP_PX`), but every
  surface that *shows* it crops to a **4/3 window** — a quarter less height than
  the square it used to draw, given back to the findings under it. `object-fit:
  cover` around a centred pin crops evenly top and bottom, so nothing about where
  the site is is lost, and the same ratio is used by the report pane, the Focus map
  step, `#print-root` and the HTML export, so what is tuned is what is delivered;
- orders the **left column as the workflow itself** — ① choose a site, ② check the
  site details, ③ run the checks, ④ finish & include each source, with the report
  itself in the right column (it is the deliverable, not a fifth step, so it
  carries a document header rather than a step number). Step ③ (`#run-checks`) holds the whole assistant round trip
  in one card: **Run auto-checks**, **Copy prompt** and the box the JSON reply is
  pasted into, so it never needs a scroll. Everything belonging to a *different*
  way of working — batches, file imports, the BYOK agent, display preferences —
  lives in the `<details id="advanced">` card at the foot of the column, closed by
  default (open state remembered), which is why a first-time operator sees only
  the four steps;
- **stands each step down once it has served its purpose**, so the pane costs its
  height in preamble once rather than on every visit forever. The measured
  ~2,400 px above the first source card is now ~350 px, in four moves. ① folds
  away as soon as a site is open (`setSitePickerOpen`) — the site header names the
  site and carries **Change site**, and the rail's ① button un-folds the picker
  without discarding the workspace. ② is a **document header** at rest
  (`renderSiteHeader`, ~130 px from 1,201 px): name, ids, copyable coordinates,
  a thumbnail per locator map (click → the same lightbox) and the photo count.
  The full station record, the assessment date/maintenance fields, both maps'
  radius/labels/refresh controls and the photo dropzone are all still there, one
  **Details** disclosure away (`LS_SITE_DETAILS`, remembered per browser) —
  they are *tuning*, and their defaults are right. Because a screenshot pasted
  with the panel shut must still land on the site, a document-level paste handler
  (`wireSiteDetails`) claims the image pastes that no dropzone and no text field
  took. ③ folds pass by pass: a sub-step that has been run becomes a one-line
  receipt of what it did — `state.flow.notes[key]`, persisted per site alongside
  the done flags, so it survives a reload — with its re-run one click away
  (`data-flow-again`, which unfolds *and* re-runs in the same click); once all
  three are done the card itself is one line (~56 px from 584 px) behind
  **Re-open**. ④'s **How to work through the list** is **onboarding, not
  furniture**: shown expanded on a first visit, and after the operator has
  finished one site — everything answered, or any export — it only ever appears
  from the `?` in that card's header (`isOnboarded` / `markOnboarded`,
  `LS_ONBOARDED`, seeded by the older "guide collapsed" key). Nothing here is
  deleted; everything is one labelled click away;
- gives the report pane a **document header** of its own (`renderReportHeader`,
  `.rdoc`, ~117 px, pinned): *Environmental Site Summary* over the site name, then
  station number · state · delivery group · coordinates · assessment date, with
  WMO number, facility types and site maintenance one **Details** disclosure away.
  The right pane is the deliverable and used to carry no title block at all — an
  operator scrolled down to *Invasive Animals* was editing an untitled document,
  and in a batch nothing on that side said which site's report was on screen.
  Beside the identity sit the two roll-ups, both live and both shortcuts to what
  they count: **n of 11 sections reviewed** (the same word as the tick it counts)
  and the **consistency-warning count**, which scrolls to the first offending
  section. Where the sections end, `renderReportCompleteness` says what is still
  missing — no statement, an empty comment, no included evidence, not yet reviewed
  — each count a jump to the first section that has that gap, next to *Check
  report*. Both surfaces read one `reportRollup()`, which groups every included
  card by section in a single pass (it runs on each keystroke in a section note),
  so the header and the foot can never disagree about how finished the report is.
  This is the on-screen surface only: `reportObject()` and `buildReportHtml()` are
  untouched, and the exports are byte-identical;
- **splits a section's evidence by what each entry actually is**
  (`renderSectionEvidence`, `.r-evidence`), because three different things used to
  render identically. On the fixture site twelve of twenty "evidence" blocks were
  not evidence: four said nothing was found, six said an interactive portal
  *"requires manual query"*, two said a search had failed — each in the same grey
  panel, at the same weight, as a confirmed EPBC matter, distinguished only by an
  11 px status pill. *Threatened Habitat* read as thoroughly evidenced while
  resting on one real result and four notes about tools nobody had opened. For a
  document whose whole purpose is to flag gaps rather than hide them, the honesty
  was in the data and the layout undid it. Entries are now grouped:
  **Findings** (`found`) keep the full panel — they carry the conclusion, ≤ 3
  expanded before *+ n more*, each note clamped to three lines with *Show all*
  (measured after insertion, so the control only appears when there is more to
  show); **Checked, nothing found** (`none`) collapses to one line naming the
  sources; **Not yet checked** (`manual` / `failed` / unset) is a caveat strip in
  the `--caution` amber — a warning, not a finding — every name a jump back to its
  collection card. A collapsed entry's *pictures* are not collapsed with it
  (`appendEvidenceImages`): the Queensland Globe capture rides on a source that is
  usually still `manual`, and it is the one image in the report that has to be
  read. `sectionWarnings` gained the matching check — *"this section's statement
  asserts a conclusion, but n of its sources have not been checked"* — so the gap
  is counted in the header roll-up as well as shown. The split is carried into the
  printed and exported HTML (`evNotesHtml`), built from the `status` each
  `evidence_notes` entry already had, so the `ess-findings/1` JSON schema is
  unchanged;
- says **what the whole assessment amounts to, before the reader reads any of it**
  (`summaryRollup` → `reportSummaryBlock` on screen, `summaryHtml` in the
  artefact): one row per report section, in report order, directly below the
  locator maps on the front page. Someone about to attend a site does not read an
  ESS — they skim it looking for the one thing that changes what they do today, and
  that answer was distributed across eleven sections and twenty evidence blocks.
  The card is deliberately **high level**: a marker, the words, the section name.
  No counts of species, no source names, no narrative — its only job is to point at
  the sections worth reading. Four states, and the **three** that carry risk are
  the whole reason it is not a binary: `found` (● *Found — read this section*),
  `partial` (◐ *Not fully checked*), `clear` (○ *Checked, nothing found*), plus
  `na` (– *No sources apply*, still listed rather than omitted, because "we
  considered permits and none apply here" is information). A found/not-found
  marker would paint a section resting on four unopened portals the same green as
  one that was properly cleared — the failure the evidence split above exists to
  stop, reintroduced at the top of the page in a bigger font. Every row carries the
  glyph **and** the words, so the state survives greyscale, a photocopier and a
  screen reader; colour is the confirmation, never the message. Two deliberate
  computations: it counts **every applicable source routed to the section**
  (`applicableSources` + `targetSectionOf`), *not* `includedCardsForSection` — the
  evidence list is include-driven, so a source that came back **Found** and was
  never pressed into the report contributes nothing to it, and for a card whose
  purpose is *"is there something here I need to worry about"*, under-reporting
  because of a missed button press is the one failure that could hurt someone; and
  it counts **internal / login-only sources too**, because on most sites the only
  source routed to *Permits* is the Bureau's own permits register and to
  *Biosecurity* the POPE / leasing files — excluding them would print *"No sources
  apply"* against permits for a site whose permit position nobody had checked.
  Reading `applicableSources()` rather than `sourcesForSite()` also keeps a marker
  from moving when the collection header's *Show internal* checkbox is ticked. A
  section whose standardized statement is a "matters present" option reads as
  `found` even with no found card behind it (`statementAssertsMatters`, the same
  index logic `sectionWarnings` uses — see `dropdowns.json` below); "still needs
  someone" is `isOutstanding`, the same definition the collection bar, the rail
  badges and the group roll-ups count with. One pure function feeds all three
  surfaces — the report pane, Focus mode's front-page step and the exported
  artefact — so they cannot disagree about a marker; on screen each row is a jump to
  its section and hovering it lights that section through the same reciprocal
  highlight a collection card gets (`linkPartners`), in the HTML export each row
  links to the section anchor (`id="pr-sec-…"`, added in that build only, so the
  print string injected into the live document carries no duplicate ids), and in
  Print/PDF the rows are inert. The card re-renders with the report, and
  `refreshSummaryCard()` replaces it in place from `refreshSection()`, so a
  statement change moves its marker without rebuilding an image-heavy pane;
- lays the workspace out as **two independently scrolling columns** (collection
  left, report right) sized to the viewport below the topbar. Each column pins
  what has to stay reachable while the other content scrolls: the progress card on
  the left, the report's document header on the right, and the dashboard's category
  headings under the progress card. The pinned offsets are measured into CSS
  variables by `app.js` (`--topbar-h`, `--status-h`, `--rdoc-h`) rather than
  hard-coded, because those boxes change height with content and window width;
  each column's `scroll-padding-top` is derived from them, so a jumped-to card or
  section lands below the pinned box rather than underneath it. The handles on
  the seam collapse either column so the other takes the full width — one at a
  time, remembered in `localStorage`;
- **joins the two columns**, which the layout could express for free and was
  instead paying for in chrome. The only join used to be a repeated card number
  plus two buttons per pairing whose entire job was *find the other half of this*.
  Every card carries `data-section` (its target) and every report section carries
  the same value, and from that one attribute:
  **hover or focus either half tints the other** (`linkPartners` /
  `setLinkHighlight`, `.is-linked`) — one delegated `pointerover`/`focusin` pair
  on the document rather than listeners per card, because both panes re-render
  constantly. A card lights its one section; a section lights every card feeding
  it. Pure accent change — a tint, a left accent bar and a `⇢`/`⇠` marker on the
  heading, so there is nothing to suppress under `prefers-reduced-motion` and
  nothing lost in greyscale;
  **`＋ Include` says where it went** (`INCLUDE_FLASH`, `.inc-receipt`,
  `role="status"`) — the most causal action in the tool used to land three
  thousand pixels down the other pane with no feedback at all. The receipt names
  the destination and the name is the link, and the destination section wears the
  same `.is-linked` accent for a moment. Transient and deliberately unpersisted:
  it is feedback on an action, not card state;
  **the destination reads as text** (`renderIncludeTarget`) — a 200 px `<select>`
  carrying all eleven sections, on every card, permanently, was heavy machinery
  for a choice the default gets right nearly every time. The full `<select>` is
  one click behind *change*, and leaving it without choosing is a cancel;
  **report evidence names are the way back** — the standing `⇠ Show` on every
  entry, whose visible label never said where it went, is gone; the source name
  is the control, the same pattern the collapsed strips already used;
  **starved sections are visible from the left** (`starvedSections`,
  `renderStarvedSections`) — an empty section used to be discoverable only by
  scrolling the report. A section counts only when a source that applies to this
  site belongs to one of its categories, so a site with no permits sources is
  never told that *Permits and permissions* is empty; and
  **linked scrolling** (`alignPanes`, third handle on the seam) keeps the panes
  aligned by section, matching the topmost thing in view in the pane being
  scrolled to its counterpart in the other. Off until asked for — moving a pane
  nobody touched is a surprise — remembered in `localStorage`, stood down (and
  visibly disabled) whenever a pane is collapsed or the layout has stacked. A
  short timestamp lock swallows the echo each programmatic scroll raises, and an
  8 px deadband stops it fighting the operator's own scrolling;
- persists per-site state in `localStorage`, split across two keys per site: a
  small **text** key (findings text, report, prefs — rewritten on every keystroke)
  and a larger `…:img` key holding the photos + satellite map data URLs (rewritten
  only when images change). This keeps note editing fast on image-heavy sites;
  legacy single-key saves are migrated to the split layout on first edit. The
  text key's `ui` block carries the per-site presentation state: `ui.groups`
  (category collapses), `ui.filter`, `ui.flow` (how far step 3 got) and
  `ui.focus.step` (Focus mode's cursor — see below);
- exports Print/PDF, self-contained HTML, and a JSON findings object — photos
  are embedded inline in all three. The consistency warnings are **not** written
  into the handover artefacts (Print/PDF, HTML): they address the operator about
  their own draft — *"reconsider the statement"* — and the recipient cannot act
  on them. They stay on-screen, in the header count, on the Focus section step,
  in the *Check report* prompt and in `sections[].warnings` in the JSON (working
  state that round-trips back into the tool, not a document); `guardExport` is
  what stops unresolved ones leaving unnoticed.

### Focus mode — the second presentation (`#focus`, `assets/app.js`)
The split view described above is a **cockpit**: everything reachable, nothing
hidden, the operator choosing what to look at next. That suits some people
exactly; for others the problem is not how much is on screen but that they have
to decide what to do next on every screen. **Focus mode** is a second route
through the same tool — one column, one step per screen, and the tool proposing
the order. It is the **default view**; the workbench is one labelled click away
in the top bar (`#btn-mode`, label always names the destination), and the choice
is remembered per browser in `ess-workbench:v1:mode`.

It is a presentation, not a second application:

- **One state, two presentations.** Every step reads and writes the same
  `state.findings` / `state.report`, the same `localStorage` schema and the same
  `ess-findings/1` export. There is no per-mode data and nothing to migrate.
  `setUiMode` calls `flushSave()` before either switch, so an in-flight debounced
  keystroke is written before the DOM it was typed into goes away — switching
  mid-edit is lossless in both directions.
- **The other mode is not merely hidden.** While Focus is live the two columns
  are *emptied*: their children move into detached holders (`detachWorkbench`),
  and the dashboard and report-section regions — the purely derived ones — are
  dropped entirely and rebuilt from state on the way back. `display:none` still
  builds and keeps ~400 controls, which is the cost this mode exists to avoid.
  Code that *reads* a stashed control rather than rendering into one (chiefly
  `sourcesForSite()` reading `#toggle-manual-internal`) keeps working because a
  document-rooted `$`/`$$` lookup that misses falls through to the holders.
  A step whose body is already exactly a workbench control **borrows the node**
  (`adoptNode`) rather than growing a second copy — the site picker is the first.
- **The step graph is derived, never stored** (`focusSteps()`, pure). Each step
  is `{ id, phase, kind, ref, state }` — `id` stable across recomputation
  (`src:qld-globe`, `sec:invasive_plants`), `phase` one of *site · checks ·
  sources · report · finish*, `kind` `input` or `output`, `state` one of *done ·
  needs-you · skipped · blocked · not-reached*. Because it is recomputed on every
  render, re-routing a card, importing a batch or applying an agent reply
  reshapes the flow immediately and correctly.
- **The interleave** is what makes this more than a wizard. Every card resolves
  to exactly one report section via `targetSectionOf()`, so the order is a
  grouping: *for each report section, in proforma order, its sources and then the
  section itself*. Within a section the source steps use the dashboard's own
  `sortCards()` ordering. The operator reviews each output while the evidence is
  still in their head and reaches the end with a finished report rather than a
  finished checklist.
- **The gate.** A section step unlocks (`blocked` → `needs-you`) when every
  source routed to it has a *recorded status*, not a sign-off: `manual` and
  `failed` are final answers from the operator's point of view, and gating on
  sign-off would strand the flow on exactly the sources that can never be closed
  from a desk. "Still needs you" keeps its one definition (`isOutstanding`) and
  is what a step's own state reports — so a manual source is simultaneously *an
  answer the section can be written from* and *still on somebody's list*, which
  is the truth. A section with no sources routed to it still gets a step, marked,
  and never blocks progress.
- **Only the cursor persists**, per site, as the step's **id** in `ui.focus.step`
  — never an index, because the list re-orders as work lands. When the step it
  names disappears, `resolveFocusCursor` lands on the nearest *earlier* survivor
  rather than throwing the operator back to the start. Skips are session-only:
  "skip" is *not now*, not a decision about the assessment.
- **Settled work is not presented.** A source step is `done` once it is signed off
  *or* answered and not outstanding, and forward movement (`Continue`, `Skip for
  now`) steps over those rather than showing a screen that asks nothing — twelve
  of a typical site's sources come back settled from the automated round trip, and
  re-walking them is the volume this mode exists to answer. `Back` deliberately
  does **not** skip: it is the retracing motion, and by the time it is pressed
  Continue has usually just settled the very source it would be retracing to.
- **Nothing is trapped.** The step list (`All steps ▾`) shows every step with its
  state and jumps to any of them, `Skip for now` is always available, and no step
  is a dead end. Where a surface is reached by handing over to the workbench
  rather than by a Focus body, that handoff is a labelled button saying what it
  opens, so no capability exists in only one mode. The cross-pane jumps (`showSourceCard`,
  `showReportSection`) resolve to the corresponding *step* while Focus is live,
  rather than silently doing nothing against a pane that isn't built.
- **One primary action per step.** Continue is it on most steps — but when the
  step's *body* carries a visible filled button (the pass this step is, the
  picker's own action), Continue steps back to `secondary`. The borrowed node's
  own classes are never touched; `syncFlowSteps` owns those and the workbench
  wants them back exactly as they were.
- **Arriving is one announcement, and it is the only one.** Every navigation moves
  focus to the step's `<h2>`, and the heading carries an `sr-only` prefix so its
  accessible *name* is "Step 14 of 41 — Queensland Globe". There is deliberately no
  `aria-live` on it: focus and live together say the same step twice. The shell is
  rebuilt by every background re-render — a keystroke in a note, a map landing, an
  agent writing a result — so a notice that merely *persists* across renders is a
  brand-new live region each time and gets read out again; `fxLive()` marks a
  notice live on the render that first shows it and inert on the ones after, keyed
  by its content. Progress is stated in words (`.fx-done`) beside the bar, which is
  `aria-hidden`. Step state is a glyph *and* a word, never colour alone.
- **Focus survives the re-render, because ids do.** Nothing in this mode may leave
  focus on `<body>` — that is the same as losing it, and it is the failure a step
  view invites, since the screen is replaced under the operator constantly. Every
  control that can hold focus has a stable id (`fxli-src:qld-globe`,
  `fx-open-qldmap`, …), which is what `renderFocus`'s caret hand-back and
  `restoreFocusAfterDialog` both key on: a dialog that rebuilt its own opener while
  it was up still finds the replacement, and failing that lands on the step
  heading. `wireMenuKeys` re-resolves its trigger for the same reason.
- **Keyboard.** `Alt+→` / `Alt+←` *press* `#fx-next` / `#fx-back` rather than
  reimplementing them, so a shortcut can never drift from what Continue actually
  does — the sign-off, the errand return, the last-step wrap all come with it. They
  are inert while any modal is up (`dialogOpen()`). Alt is forced by the surface:
  it is full of textareas, selects and a roving-tabindex radiogroup, so bare arrows
  and Enter belong to the controls. The step list is a real `role="menu"`, one
  `role="group"` per phase, sharing `wireMenuKeys` with the overflow menus.
- **Narrow screens and motion.** Below 620px the chrome collapses to phase + *n of
  m*, the nav footer goes `position: sticky` (never `fixed` — sticky keeps its
  space in the flow, so it cannot cover the last control), every footer button is
  ≥44px, and the photo zones drop their paste prose for a full-width pick control,
  since Ctrl+V and drag-and-drop do not exist there. Tested at 360px. The step
  transition is gated twice: on `prefers-reduced-motion: no-preference`, and on an
  `is-entering` class that `renderFocus` sets only for a real navigation — without
  the second gate a keystroke in a note would re-run it on every character.

#### The step bodies (`FOCUS_BODY`, `focusStepBody`)
A body is written once and used by both modes wherever that is possible at all,
which in practice means one of three shapes:

1. **Borrow the workbench's own node** (`adoptNode`), for a control that already
   does exactly the step's job — the site picker, the correction disclosure
   (`#sd-correct`), the date/maintenance fields, the two map sections
   (`#site-maps`), the photo dropzone (`.photo-section`), and each step-3 pass's
   `.flow-do`. Every listener, every piece of state-syncing and every receipt
   comes with it, so a run in Focus *is* a run in the workbench; there is no
   synchronisation routine because there is nothing to synchronise. What is
   borrowed goes home on the next render or mode switch (`releaseAdoptedNodes`).
   A borrowed node can be re-styled for the step it is standing in — the map
   sections come side by side in the report's own 4/3 crop rather than the pane's
   3:1 strip, and their tuning controls fold away behind one button, because at rest
   that step asks *one* question.
2. **Share the renderer**, where the report pane and a step must show the same
   thing but cannot share a node (the pane isn't built while Focus is live):
   `reportIdentityText()`, `reportMapsBlock()`, `reportPhotosBlock()` and
   `sectionReviewToggle()` are called by `renderReport()`/`renderReportHeader()`
   and by the `out:identity` and `sec:…` steps alike. A shared renderer may need
   the *container* as well — `refreshSection`, `renderReportWarnings` and
   `syncBioDetail` all take a `box` to find `.r-warns` / `#bio-detail` in — so a
   step body passes itself, and only one mode's copy of either is ever live.
3. **Read state directly**, for text — `stationRecordRows()` is the station
   record for the metadata grid and for the step's read-back both.

##### The source step (`focusSourceBody`)
The headline step, and where most of an assessment is spent. It is shape 2 taken
as far as it goes: `renderStatusControl`, `renderPhotoBlock`, `renderWikiImageRow`,
`renderIncludeRow`/`renderIncludeTarget`, `renderCardMenu` and `paintResult` are
the card's own renderers, so a source answered in Focus *is* answered in the
workbench and the other way round — there is nothing to synchronise. Two of them
take one option for this caller: `renderStatusControl(…, { open: true })` holds
the four-way picker open at every status (on a screen of its own the answer is the
whole question, and a Manual source collapsing to a chip would ask for a click
before it could be changed), and `renderIncludeRow(…, { signoff: false })` drops
the sign-off pill, because here the step's **Continue** records it.

The card's sequence — *identity → what came back → your answer → evidence → into
the report → done* — is kept exactly. What changes is that the card **is** the
screen, so the compaction a column of 23 forces comes off: the `ⓘ` disclosure's
"what to look for" is open prose, the finding is shown in full rather than clamped
to four lines, and the evidence zone opens when the result is `Found` (via the
same `CARD_OPEN.photos` set the card uses, so a zone opened in either mode is open
in both). The `⋯` stays a `⋯` — those really are occasional — and it carries
Focus's escape hatch to the full card. Specialist tools (Queensland Globe's site
map, the PMST Excel import, the live API checks) are invoked from the step itself;
the runners paint into `#run-…`/`#res-…` by document lookup, and only one mode's
copy of those ids is ever in the document.

Two mechanisms make this work from the app's existing call sites. `refreshCard(id)`
re-renders the current **step** when Focus is live — every mutation in the app
already calls through it, so both modes repaint from the same places. And a
background re-render now *carries the caret across* (`readCaret`/`writeCaret`)
instead of skipping itself to defend it: a screenshot pasted while the note has
focus has to appear, or the paste reads as having done nothing.

##### The report section step (`focusSectionBody`)
The other half of the interleave, and the half that makes this more than a wizard.
The operator has just worked through every source routed to this section; the
evidence is still in their head. The step asks the one question worth asking at
that moment — *here is what the report now says about Invasive Plants, is that
right?* — in five parts, in the order a person answers them:

1. **What this section concludes** — the standardized statement (`suggestChoice`
   pre-suggests it from the evidence), and for Biosecurity the derived declaration
   text (`syncBioDetail`, painted into the same `#bio-detail` id the report pane
   uses; only one mode's copy is ever in the document).
2. **⚠ Anything inconsistent** — `sectionWarnings`, inline, live on every keystroke
   and every change of the statement (`refreshSection`). **This is the step those
   warnings were written for.** In the workbench they sit in the right pane, where
   an operator concentrating on collection may never look; here they are on screen
   at the moment the operator is deciding, which is the only moment they can act on
   them. They remain screen-only and never reach the exported artefact.
3. **The detail** — the free-text note, with **Insert suggested detail**
   (`sectionNarrative`) drafting from this section's evidence plus
   `statements.json`. It appends below whatever is written; it has never
   overwritten and must not start.
4. **What it rests on** — `renderSectionEvidence`, unchanged: *Findings* at full
   weight, *Checked, nothing found* on one line, *⚠ Not yet checked* as a caveat
   strip. A collapsed entry's photographs are not collapsed with it.
5. **Reviewed ✓** — `sectionReviewToggle`, the section's own tick. The same flag,
   the same setter and the same `reportRollup()` tally as the report pane's
   checkbox, and deliberately *not* the card-level sign-off.

Four rules the shape follows from:

- **The errand.** The caveat strip — *three of these sources were never checked* —
  is a prompt to go and check one, and it is only worth putting on the step if
  coming back is free. A jump that starts on a section step arms `focusReturn`
  (in `showSourceCard`, so every route in — an evidence name, the caveat strip's
  button, the waiting list — gets it for nothing). The step it lands on says where
  it came from and its **Continue** is labelled with the way home; every other
  navigation clears it, so the offer can never outlive the errand.
- **A re-opened gate loses nothing.** A section step's `done` is `reviewed && gate`,
  so a source reset to *Not checked* after sign-off re-locks the step — but the
  statement, the note and the tick are recorded state and the graph never takes
  them back. The step says it needs another look, in amber, above work that is all
  still there.
- **Nothing is trapped**, here too: a section reached before its gate opens is not
  a form the operator is locked out of. The gate is about *ordering*, so an open
  gate says what is outstanding and offers the errand, and the controls stay
  usable below it.
- **An empty section is one screen, not a blank form.** A section no source on this
  site feeds says exactly that, and its **Continue** records the review — which is
  what keeps `finish:export` reachable without a form that asks nothing.

Two consequences worth stating. The report's **front page** (`#rsec-identity`,
`state.report.identity`) became a real report section with its own Reviewed tick,
because a Focus step needed one and a control that exists in only one mode is not
allowed; the locator maps and the station photographs were two headed blocks
before and are its two halves now, with the traffic-light summary card between them
(`reportSummaryBlock`, above) — both modes build the front page from the same three
functions, so the page a Focus user signs off is the page the report shows. And the **station record is correctable** —
name, WMO, delivery group, facility and state — from a disclosure that both modes
show, because the step reads the record back as a confirmation and a confirmation
you cannot act on is a dead end. Station number and coordinates are deliberately
*not* editable there: `siteKey()` is built from them, so changing one is a
different site rather than a typo, and *Change site* is the route to that.

##### The finish step (`focusFinishBody`)
Where the flow ends, and the only place in Focus that looks at the whole
assessment at once. Every section has already been reviewed on a step of its own,
so this is a last look and a handover, not a second review — six things, in the
order a person leaving the building uses them:

1. **At a glance** — `renderFindingsGlance()`, the traffic-light card: every
   source grouped by what it came back with, findings first, then what a human
   still owns, then the empty searches that are good news. Each row jumps to the
   first source with that result. Count, word *and* `.s-dot` glyph, so it survives
   greyscale and CVD. It is a free-standing node on purpose. Not to be confused
   with the report's own summary card (`summaryRollup`, above): this one counts
   **sources by status** for the operator, that one marks **sections** for whoever
   reads the report.
2. **What's still missing** — `completenessGaps(reportRollup())`, the same gap
   definition the pane's `#report-complete` box uses, so the two can never name
   different gaps for the same state. Every count is a jump, and in Focus
   `showReportSection` resolves to the `sec:…` **step** that fixes it.
3. **Unresolved warnings** — the `reportRollup()` count and a jump to the first.
4. **Read the whole report** — `openReportPreview()`: the assembled artefact on
   screen, built from the same `buildReportHtml()` the printer gets and wearing
   the same `.pr-paper` stylesheet as `#print-root`, so it is a preview of the
   deliverable rather than a third rendering of the report.
5. **Export ▾** and 6. **Check report** — `adoptNode`s of `#report-export-menu`
   and `#btn-check-report`. Not copies: the same two controls with the same
   handlers, which is what makes *an export from Focus is byte-identical to an
   export from the workbench* true by construction rather than by testing.

Finishing is **never gated on completeness** — a person who has to hand something
over now gets to, with every gap named. The one thing an export says out loud is
an open consistency warning (`guardExport`, wrapped around all four handlers so
both modes get it): once, per site, per session, and only when the operator went
ahead, because a dialog that fires on all four formats in turn is one that gets
clicked through. `#focus` is hidden in `@media print`, so Print/PDF from Focus
produces the report and not the step chrome.

##### The escape hatches
Four surfaces are large, specialised and used on a minority of assessments.
Building Focus equivalents for all of them would roughly double the mode, so the
rule is **reachable, not reimplemented** — and where one genuinely needs the
cockpit, Focus says so in words and hands over.

| Surface | In Focus |
|---|---|
| **Queensland Globe** (`openQldGlobeMap`) | Opened straight from the Queensland Globe source step. It is already a full-screen, single-purpose surface — the most Focus-shaped thing in the tool. |
| **PMST Excel import** (`parsePmstMnes`) | Runs in place on the EPBC source step; the parsed matters and drafted narratives flow into the threatened-section steps as they do in the workbench. |
| **BYOK agent** (`assets/agent.js`) | `focusAgentHatch()` on `checks:auto`, shut by default — an assessment about to be worked by hand should not open with a request for a credential. The panel is *borrowed*, so there is no second copy of a control holding an API key, and its own Close folds the disclosure with it. |
| **Batch** (`importBatch`, `createBatchFromSites`) | **Handoff** (`offerBatchHandoff` / `renderFocusBatchOffer`). |

The BYOK agent needs no Focus-specific plumbing to *run*: it writes through the
same `window.ESS` seam everything else does, `setResult` calls `refreshCard`,
which in Focus re-renders the step, and the graph is recomputed from state on
every one of those — so the flow reshapes itself as the answers land. What Focus
adds is the landing: `ESS.endRun` records the three round-trip passes' receipts
(the run *is* that sequence, done in one action) and `focusAfterRun` resumes at
the first step that still needs a human. Both are conditional on
`agentRunWrote` — `endRun` fires from agent.js's `finally`, so a run that fell
over on its first turn arrives there too and must not be recorded as done.

Batch is the one surface that is genuinely not Focus-shaped: it is a way of
working *across* sites, and Focus is a way of working *through* one. Loading a
batch therefore offers a labelled switch and says why, in the shape every handoff
here follows — a deliberate action naming what it opens, never a silent mode
flip. Declining is a real answer: the first site is already open in Focus, the
batch stays loaded, and the tray is in the workbench whenever it is wanted.
`resetFocusCursor` clears the offer, so one site's can never be read as another's.
Returning from any handoff lands on the same step, because the cursor is per-site
state and no handoff touches it.

### Queensland Globe site map (`assets/qldmap.js`)
A separate, lazily-initialised module behind `window.ESSQldMap`. It draws a
**real interactive ArcGIS map** of the site — Queensland aerial imagery with the
ESS environmental layer stack over it and the station pinned — so the operator
can sanity-check the position and what the layers show, then capture that exact
view for the report. It is only offered on QLD sites, from the Queensland Globe
collection card.

- **Nothing loads until it's opened.** The Esri bundle (~1 MB from
  `js.arcgis.com`) and every QLD service call happen on first open, so the
  workbench stays a fast, dependency-free page for the sessions that never use
  the map.
- **Sublayer IDs are resolved at runtime, never hardcoded.** Queensland's
  MapServer sublayer IDs are undocumented and not stable, so every catalogue
  entry declares a name `match` and each service's live layer list (`?f=json`)
  is read once per open and matched by name; a `fallback` id is a last resort.
  A layer that resolves to nothing is **withheld** and says so — in the panel
  and in the diagnostics — rather than silently drawing the wrong dataset.
- **The aerial imagery goes on the map *before* the `MapView` is constructed.**
  This ordering is load-bearing, not cosmetic. A 2D `MapView` takes its spatial
  reference from, in order, an explicit `spatialReference`, the basemap, then the
  first layer on the map — and there is no Esri basemap to lean on here, because
  those need an API key. Built over an empty `Map` the view never resolves a
  projection, so it creates no layer views, never reaches `ready`, and
  `view.when()` never settles: the modal times out with *"the map could not
  start"* while every layer still reads `pending`. If the ImageServer is
  unreachable the view is told the projection outright (Web Mercator) and opens
  without a base picture, rather than leaving a dead modal. The diagnostics print
  the view's projection so this state names itself.
- **One `MapImageLayer` per service, not per layer.** Forty-odd catalogue
  entries map onto ~15 services; drawing each as its own layer would be forty
  `exportImage` round-trips per pan. Toggling a layer flips one sublayer's
  `visible` on a layer that already exists.
- **Everything external is bounded and self-reporting.** Each call has a
  timeout, each failure is worded for a non-developer, and a per-service
  diagnostics panel (copyable as plain text) says exactly what worked. One
  layer failing never stops the map, the pin, or the capture.
- **The capture is guarded.** The raw screenshot raster is measured before any
  fill is painted over it: a mostly-transparent, few-colour frame means the map
  never rendered (typically a suspended view), and it is refused with an
  explanation rather than exported as a plausible-looking blank.
- **One press captures AND adds.** Capturing and adding were separate buttons;
  the second press decided nothing and was mostly forgotten, leaving a captured
  map that never reached the report. `captureForReport()` does both, from either
  the header button or the one in the capture card, and the thumbnail is the
  receipt. The card is the FIRST thing in the panel — taking the picture is what
  the modal is for, so it does not sit below sixty layer checkboxes.
- **"Is the pin in shot?" is provenance, not a warning.** `pinInView()` asks the
  view where the pin lands in screen pixels (`view.toScreen`), which needs no
  projection engine and assumes nothing about the map's CRS — unlike an
  `extent.contains()` test, which compares degrees against a projected extent in
  metres and calls a well-framed map "outside". The answer is recorded with the
  capture and printed in the diagnostics, but it no longer raises an alarm on the
  card: the check was wrong often enough that the warning trained operators to
  ignore the one place the capture reports itself.
- **Layers go to an appendix, not onto the picture.** A ticked stack is far too
  long for an on-map legend or a report section, so the picture carries only the
  site, coordinate, scale and layer *count*, and the full list travels into
  **Appendix A** of the report (see below). `state.qldMap` holds the ticked
  selection (persisted, so re-opening restores the stack) and the capture record
  that the appendix renders from.
- **Click the map to ask what is under that point.** Forty translucent layers
  stack on one picture and the panel's group colours are *ours*, not the
  services' — so a shaded patch cannot be read back to a layer by eye. A click
  runs one ArcGIS `identify` per MapServer (restricted to the ticked sublayers,
  `all:` so a scale-suppressed layer still answers) and names every layer
  covering the point in a popup, with the feature's own attributes and the
  service's legend swatch. One call per *service* for the same reason the map
  draws one `MapImageLayer` per service. A service that cannot be asked is
  **named** in the popup — "nothing is here" and "we could not ask" are very
  different answers. The built-in Esri popup is disabled (`popupEnabled=false`)
  so two popups never fight over one click, and the ring marking the asked-about
  point is removed before every screenshot so it can't reach the report.
- **Symbology comes from `/legend?f=json`, never invented.** Each service
  publishes the exact PNG swatches it paints with. They feed both the click
  popup and the per-layer **legend boxes in Appendix A**, so a colour on an
  exported map can be traced to the layer that drew it. A swatch is only shown
  against an identified feature when it can be matched with certainty (by the
  renderer's `values`, then its label) — a wrong colour beside a layer name is
  worse than none. Legends are read in the background as the map draws and
  awaited (bounded) before a capture; a layer without one still reaches the
  appendix by name.

`app.js` owns all persistence and passes two callbacks in — `onChange` (ticks
changed) and `onAdd` (a captured map). The picture follows the ordinary card-image
path into the report and every export; the layer list is exported as a top-level
`qld_globe_map` object in the JSON findings, so a re-imported report rebuilds its
appendix even without the picture.

The capture record's **legend swatches are base64 PNGs**, so they are split out
of the per-site *text* payload (rewritten on every keystroke) and stored with the
images, which are only rewritten when an image changes; `restore()` reunites them.
In the report the captured map is not treated as an evidence thumbnail: it is
rendered full width with the height following the width, and clicking it opens it
full screen — via the existing lightbox on screen, and via a script-free
`:target` overlay in the exported HTML, so a saved copy still works offline.

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
`{ schema, generated, tool, site, sections[], collection_log[], qld_globe_map? }`, statuses
`found|none|failed|manual|unset`. It is emitted by `app.js reportObject()`,
scaffolded by `resolve.py --template`, and consumed by `app.js importFindings()`
— so a file the skill writes and a file the tool exports are interchangeable.
**Importing a file for the site already open merges rather than replaces**
(`applyFindings` → `isSameSite` → `mergePrevious`): an entry that carries no
status, note, result or photo leaves the existing result alone, and the
operator's own bookkeeping (sign-off, include target, card photos) carries
across an entry that does. This is what lets the primary workflow run the
auto-checks *before* the assistant's reply comes back without the reply undoing
them. A file for a different site replaces the workspace as before.
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

An optional top-level `qld_globe_map` carries the provenance of the Queensland
Globe site map: `{ captured_at, lat, lon, scale, pin_in_view, selection[],
layers: [{ id, name, group, service, url, sublayer, legend?, legend_more? }] }`,
where `legend` is `[{ label, swatch }]` — the service's own symbol for that layer
as a `data:` image, capped per layer with `legend_more` counting the rest. It is
deliberately **not** nested under `site` — the report's Appendix A is built from
it directly, so a re-imported file lists the layers the map was drawn from, *and
what each one looks like on it*, even when the picture itself didn't survive the
round trip. Every swatch is re-validated as a `data:` image on import, the same
way photos are. Agents don't produce any of this; only the browser tool's map
modal does. The captured map itself travels as an ordinary card image marked
`kind: "qld_globe_map"`, which is what tells the report to render it full width
and clickable rather than as a thumbnail.

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
from the collection result. **Build-generated** from the FWIN ESS Template — do
not hand-edit.

### `statements.json`
Hand-authored narrative templates (durable; *not* build-generated) that seed the
report-section detail text: the impact-assessment sentence, per-state General
Biosecurity Obligation paragraphs, the QLD Koala Conservation Plan district logic
+ link, cultural-heritage duty-of-care, and the migratory/acid-sulfate notes.
Consumed by `assets/app.js` (PMST import section-seeding and the "Insert suggested
detail" button) and surfaced to the agent via `resolve.py --json`. Loaded
best-effort — a missing file just disables the auto-draft, never breaks the tool.

## The status taxonomy

Every source resolves to one of four, and the difference is the product:

- **Found** — returned something to record.
- **Nothing found** — checked successfully, nothing relevant.
- **Search failed** — could not get an answer (network / CORS / egress / error).
- **Manual** — needs a human (interactive GIS portal, draw-a-polygon report, or
  internal login), with the aimed link + steps.

"Nothing found" and "failed" are deliberately distinct: *absent* and *unknown*
are different risk positions for someone about to attend a site.

That distinction is what the report's summary card is built on. Its four section
states are derived from these four, never a re-definition of them: any **Found**
source (or a "matters present" statement) makes a section `found`; any source still
**Manual**, **Search failed** or **Not checked** — `isOutstanding`, the one
definition every tally in the app counts with — makes it `partial`; only a section
whose sources have all answered and none found is `clear`. A two-state
found/not-found summary was considered and rejected for exactly the reason above:
it would collapse *absent* and *unknown* into one green marker at the top of the
page.

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
