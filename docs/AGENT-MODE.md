# Agent mode — running the assessment with Claude

The `ess-collect` agent can do the desktop research for you and fill the same
review/export surface a human uses. There are **two ways** to run it; both
produce the same `ess-findings/1` object.

```
                        ess-findings/1  (one schema)
                       ┌───────────────┐
   Claude Code ───────▶│  collection   │◀─────── BYOK in-browser agent
   (file handoff)      │     log +     │         (this browser + your key)
                       │   sections    │
                       └───────┬───────┘
                               ▼
              ESS Workbench: review Manual/Failed → finalise → export
```

---

## A. File handoff (any external LLM — or Claude Code)

Runs the research outside the browser, then imports the result. No key in the
browser.

1. In the browser tool, load the site and click **📋 Copy prompt**. This copies
   a complete, self-contained, **model-agnostic** prompt for that site — every
   step, every applicable source (deep-linked to the location), the
   standardized report wording, and a ready-to-fill `ess-findings/1` skeleton.
   Paste it into whichever assistant you like (ChatGPT, Gemini, Claude,
   Copilot…).
   *Shortcut:* if you're already in a Claude Code session in this repo, the
   copied prompt's top note lets you run the packaged `ess-collect` skill
   instead (or just ask *"Run an ESS for WOODGATE ALERT"*); it fills the same
   skeleton via `resolve.py --template`.
2. The assistant works every source it can reach, assigns
   `found` / `none` / `failed` / `manual` with evidence, and returns the
   completed `ess-findings/1` JSON.
3. Paste that JSON straight into the browser tool at step 3, **Paste its reply
   back here**, and press **✓ Apply response**. (Saved it to a file instead?
   **⚙ Advanced options → Import a findings file**.)
4. The dashboard fills with the agent's results, and the collection bar lands on
   its **Needs you** segment — the **Manual** and **Failed** items still needing a
   human. Finish those (**All** brings the rest back), then export.

Best when: batches of sites, or you want to use an LLM you already pay for. No
agent can drive interactive portals (EPBC PMST) or log into SharePoint — those
come back `manual` for you to finish in the browser.

### Batches — many sites at once

For several sites, use the batch envelope **`ess-findings-batch/1`** =
`{ schema, generated, tool, sites: [ <ess-findings/1>, … ] }`. Scaffold every
site's skeleton in one call — `resolve.py --batch sites.txt --template` (a file
with one station/number or `lat,lon[,name]` per line; `-` reads stdin) — have the
agent fill each site's slot (see the `ess-collect` skill's "Running a batch of
sites"), then paste the whole object into the step 3 box (or load the file from
**⚙ Advanced options → Import a findings file**). The tool
shows a **batch picker bar** (one chip per site, with its found / still-needs-you
counts), loads each into the same review/export surface, and a **🔍 Check all**
button copies one combined fact/consistency-check prompt covering every site. The
batch grouping is remembered across visits; **Clear batch** drops the grouping but
keeps each site's saved work.

---

## B. BYOK in-browser agent (this browser + your key)

Runs the whole thing live from the browser — **beta**. Open **⚙ Advanced
options** at the foot of the left pane and click **🔑 Agent mode…**.

### How it works
- You paste **your own Anthropic API key**. The browser calls
  `api.anthropic.com` directly (with the `anthropic-dangerous-direct-browser-access`
  header). Claude runs a tool-use loop:
  - **web_search / web_fetch** — Anthropic **server-side** tools; they run on
    Anthropic's infrastructure, so they bypass the browser CORS wall that blocks
    ordinary client-side fetches of government sites.
  - **query_ala** — a client-side tool the browser runs against the Atlas of
    Living Australia (which is CORS-friendly) for structured conservation data.
  - **query_wildnet** — a client-side tool that queries the Queensland WildNet
    species API for conservation-significant taxa near the site, already grouped
    into flora (plants) vs fauna (animals) with their NCA/EPBC status (offered for
    QLD sites). If the browser blocks it, the agent falls back to `web_fetch`.
  - **set_source_result** — the browser applies each result to the dashboard as
    the agent works, so cards fill live. For species/subject sources it marks
    `found`, the agent also passes `image_subjects` (the species/subjects it
    identified); the browser auto-fetches a labelled Wikipedia reference photo for
    each onto that card (gated by the "Auto-fetch reference images" toggle).
- When every source has a result, it stops. You review Manual/Failed and export.

### The key
- Stored **only** in this browser's `localStorage`; sent **only** to
  `api.anthropic.com`; never to any other server (there is no backend).
- **Clear key** wipes it. Because it lives in the browser, a page compromise
  (XSS) could read it — use a key you can rotate/limit, not an unrestricted org
  key.

### Cost
- Each run makes many search/fetch calls plus tokens, billed to your key —
  expect **a few cents to some tens of cents per site**. The panel shows a live
  token + rough-dollar readout. The system prompt + tools are prompt-cached to
  cut cost on the turns within a run. Pick **Haiku 4.5** in the model dropdown
  for a cheaper/faster run (it uses basic web search and no web-fetch).

### Limits
- Interactive-only portals and internal SharePoint still come back **manual** —
  the agent records the aimed link + steps rather than guessing.
- Egress-blocked or erroring sources come back **failed** (honestly flagged).

---

## Shared / default key (not built)

A shared "default key" so users don't paste their own **cannot live safely in a
static GitHub Pages site** — a key baked into the build would be published. The
safe way is a tiny access-controlled proxy (e.g. a Cloudflare Worker behind SSO)
that holds the key server-side; the browser calls the proxy instead of Anthropic.
The client is written to make this a one-line change: swap `API_BASE` in
`assets/agent.js` to the proxy origin. See [ROADMAP.md](ROADMAP.md).

## The schema (`ess-findings/1`)

`{ schema, generated, tool, site, sections[], collection_log[] }` — the exact
object the browser tool imports and exports, and that `resolve.py --template`
scaffolds. Statuses: `found` / `none` / `failed` / `manual` / `unset`. Keeping
one schema is why both agent paths and the reviewer UI interoperate. A batch is
just the envelope **`ess-findings-batch/1`** = `{ schema, generated, tool, sites:
[ <ess-findings/1>, … ] }`; the importer detects the `sites[]` array and loads them
as a batch, so the same per-site object composes for one site or many.
`site` and each `sections[]`/`collection_log[]` entry may also carry an
optional `images: [{ caption, data_url, credit?, source_url? }]` — photos
attached in the browser tool (uploaded, or reference images auto-sourced from
Wikipedia, which also set `credit`/`source_url`); agents don't produce these,
but re-importing an exported file preserves them. A species/subject
`collection_log[]` entry may also carry `image_subjects: string[]` — the
identifiable species/subjects the agent found. It isn't photo data: on import
(and during a live BYOK run) the browser tool fetches a labelled Wikipedia
reference photo for each name into that card. If it's omitted, the tool falls
back to extracting subjects from `note`/`result_text`. Backward compatible —
older files simply have no `image_subjects`.
