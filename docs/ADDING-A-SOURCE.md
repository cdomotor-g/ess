# Adding a source

The tool grows by editing **`data/sources.json`**. Add one object to the
`sources` array and it appears in both the browser dashboard and the
`ess-collect` skill worklist, filtered to the right state and aimed at the site's
coordinates. No code change is needed for a link/search/manual source.

## The source object

```jsonc
{
  "id": "nsw-bionet",                 // required, unique, kebab-case
  "name": "NSW BioNet",               // required, display name
  "category": "threatened",           // required, one of the ids in `categories`
  "jurisdiction": "state",            // "national" | "state"
  "states": ["NSW"],                  // required; ["*"] = applies everywhere
  "method": "manual",                 // required: api | deep_link | web_search | manual
  "cors": false,                      // required: can a browser call it directly?
  "url": "https://…",                 // required: base/landing URL
  "url_template": "https://…{lat}…",  // optional: deep-link with placeholders
  "what_to_find": "One line on what a hit looks like.",   // shown in both tools
  "instructions": "Manual steps, if any.",                // for manual/portal tools
  "web_search": "{name} {state} threatened species",      // optional agent search
  "no_result_means": "Wording for a clean/empty result.", // optional
  "internal": true,                   // optional: needs Bureau login (SharePoint)
  "api": { … },                       // optional: see below, only for method:"api"
  "priority": 10                      // optional: lower sorts first within a category
}
```

### Categories (`category`)
Must match an `id` in the `categories` array at the top of `sources.json`:
`permits · biosecurity · threatened · indigenous_heritage · invasive_plants ·
invasive_animals · disease · additional`. These map to the ESS proforma sections.

### `method` — how it gets checked
- **`api`** — has a queryable endpoint returning data. Add an `api` block and a
  handler (below). The browser shows a **Check live** button; the skill queries
  it.
- **`deep_link`** — a URL worth opening, possibly a readable static page. No live
  query, but the agent may still extract content from it.
- **`web_search`** — best approached via a search query (`web_search` field).
- **`manual`** — needs a human: interactive GIS portal, draw-a-polygon report,
  or `internal` SharePoint. Always give `instructions` + the aimed `url`.

### Placeholders (in `url_template` and `web_search`)
`{lat} {lon} {name} {state}` and a bounding box `{lat_min} {lat_max} {lon_min}
{lon_max}` (~3 km around the point, for map "extent" params). Both the browser
(`buildUrl`) and `resolve.py` (`fill`) substitute these identically.

## Worked example — a new state map viewer

```jsonc
{
  "id": "nsw-shark-smart",
  "name": "NSW Coastal Values Viewer",
  "category": "additional",
  "jurisdiction": "state",
  "states": ["NSW"],
  "method": "deep_link",
  "cors": false,
  "url": "https://example.nsw.gov.au/viewer",
  "url_template": "https://example.nsw.gov.au/viewer?x={lon}&y={lat}&z=14",
  "what_to_find": "Coastal environmental values near the site.",
  "priority": 20
}
```

Save, then:
```bash
python .claude/skills/ess-collect/resolve.py --lat -33.86 --lon 151.20 --state NSW
```
The new source appears in the worklist with `{lat}/{lon}` filled. Reload the
browser tool on a NSW site and it appears as a card.

## Promoting a source to a live API

When a source has a real endpoint (e.g. an ArcGIS `MapServer`/`FeatureServer` or
a documented REST API):

1. Set `method: "api"`, `cors` honestly, and add an `api` block:
   ```jsonc
   "api": {
     "kind": "arcgis_identify",              // a name your handler switches on
     "endpoint": "https://…/MapServer/identify",
     "layers": "all:3,7",
     "radius_km": 5,
     "docs": "https://…"
   }
   ```
2. **Browser** (`assets/app.js`): add a handler beside `runAla`, switching on
   `src.api.kind`, that fetches, parses, sets Found/None from the data and
   Failed on error, and writes `f.result.html`. Wire a **Check live** button for
   the new kind (see how `renderSourceCard` does it for `ala_biocache`).
3. **Skill** (`.claude/skills/ess-collect/SKILL.md`): add the query recipe and
   how to read the result, following the ALA section.

Keep the browser and skill in agreement, and set `cors: false` if the service
blocks browser origins — then the browser keeps it as a deep-link while the skill
queries it server-side.

## Testing your change

```bash
# JSON validity + unique ids + valid categories/methods
python3 - <<'PY'
import json, collections
d = json.load(open('data/sources.json'))
ids=[s['id'] for s in d['sources']]; assert len(ids)==len(set(ids)), 'dup id'
cats={c['id'] for c in d['categories']}; methods={'api','deep_link','web_search','manual'}
for s in d['sources']:
    assert s['category'] in cats, s['id']; assert s['method'] in methods, s['id']
    for k in ('id','name','category','jurisdiction','states','method','cors','url'): assert k in s, (s['id'],k)
print('ok', len(d['sources']), 'sources')
PY
```
Then load the browser tool on a relevant site and confirm the card renders with a
correctly-aimed link.
