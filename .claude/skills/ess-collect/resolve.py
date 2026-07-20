#!/usr/bin/env python3
"""
resolve.py — deterministic half of the ess-collect skill.

Given a station name / number OR a lat,lon, this resolves the site against
data/stations.json and prints the applicable sources from data/sources.json with
their deep-link URLs already templated and their per-source instructions. The
agent then works through each source, assigns a status and writes findings.

Usage:
    python resolve.py --station "WOODGATE ALERT"
    python resolve.py --station 539251
    python resolve.py --lat -25.0891 --lon 152.5489 [--state QLD] [--name "My site"]
    python resolve.py --station "woodgate" --json      # machine-readable

Paths default to the repo's data/ directory (three levels up from this file).
"""
from __future__ import annotations
import argparse, datetime, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
DATA = os.path.join(REPO, "data")
BBOX_DELTA = 0.03

sys.path.insert(0, os.path.join(REPO, "build"))
from geostate import state_from_coords  # noqa: E402  — resolves state from real AU boundaries

WEEDS = {
    "QLD": "https://www.business.qld.gov.au/industries/farms-fishing-forestry/agriculture/biosecurity/plants/invasive/restricted",
    "NSW": "https://weeds.org.au/regions/nsw/", "VIC": "https://agriculture.vic.gov.au/biosecurity/weeds/weeds-information",
    "SA": "https://www.landscape.sa.gov.au/hf/landscapes-hills-and-fleurieu-stewardship-program/understand-your-responsibilities-as-a-land-manager/pest-plants-and-animals-2/pest-plants",
    "WA": "https://www.agric.wa.gov.au/pests-weeds-diseases/weeds", "TAS": "https://nre.tas.gov.au/invasive-species/weeds-index",
    "NT": "https://nt.gov.au/environment/weeds", "ACT": "https://www.environment.act.gov.au/parks-conservation/plants-and-animals/pest-plants-and-animals",
}


def load(name):
    with open(os.path.join(DATA, name), encoding="utf-8") as f:
        return json.load(f)


def load_optional(name, default=None):
    """Like load(), but returns default if the file is absent (e.g. an older checkout)."""
    try:
        return load(name)
    except FileNotFoundError:
        return default


def find_station(stations, q):
    q = str(q).strip().lower()
    exact = [s for s in stations if s["name"].lower() == q or str(s["station_num"]) == q]
    if exact:
        return exact[0], exact
    pre = [s for s in stations if s["name"].lower().startswith(q) or str(s["station_num"]).startswith(q)]
    con = [s for s in stations if q in s["name"].lower()]
    hits = pre + [s for s in con if s not in pre]
    return (hits[0] if hits else None), hits[:15]


# A batch line is treated as a coordinate pair only when it is two numbers
# (comma- or whitespace-separated) with at least one decimal point, the first in
# [-90,90] and the second in [-180,180], optionally followed by ",Name" / ";Name".
# This keeps bare station numbers (e.g. "539251") and station names as name lookups.
COORD_RE = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*(?:[,;]\s*(.*?))?\s*$")


def _as_coords(spec):
    m = COORD_RE.match(spec)
    if not m:
        return None
    a, b, name = m.group(1), m.group(2), (m.group(3) or "").strip()
    if "." not in a and "." not in b:
        return None  # two bare ints — treat as a name/number lookup, not coordinates
    lat, lon = float(a), float(b)
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return lat, lon, name


def coord_site(lat, lon, state, name=None):
    st = state or state_from_coords(lat, lon)
    return {
        "name": name or f"Site @ {lat:.4f},{lon:.4f}", "station_num": "", "wmo": "",
        "state": st, "delivery_group": "", "facility_types": [], "primary_facility": "",
        "lat": round(lat, 6), "lon": round(lon, 6),
        "refs": {"invasive_plants": WEEDS.get(st, ""),
                 "invasive_animals": "https://www.dcceew.gov.au/environment/invasive-species",
                 "diseases": "https://www.outbreak.gov.au/"},
    }


def resolve_spec(spec, stations, default_state=None):
    """Resolve one batch line to (site, note). `note` is '' or a warning string
    (ambiguous match); site is None when nothing matched (note carries the reason)."""
    spec = spec.strip()
    coords = _as_coords(spec)
    if coords:
        lat, lon, name = coords
        return coord_site(lat, lon, default_state, name or None), ""
    site, hits = find_station(stations, spec)
    if not site:
        return None, f"no station matched '{spec}'"
    note = ""
    if len(hits) > 1 and site["name"].lower() != spec.lower() and str(site["station_num"]) != spec:
        others = ", ".join(f"{h['name']} ({h['state']},{h['station_num']})" for h in hits[1:5])
        note = f"'{spec}' matched {len(hits)} sites; used {site['name']} ({site['state']},{site['station_num']}). Others: {others}"
    return site, note


def read_batch_specs(path):
    """Read one site spec per line from a file (or stdin when path == '-').
    Blank lines and lines starting with '#' are skipped."""
    text = sys.stdin.read() if path == "-" else open(path, encoding="utf-8").read()
    return [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]


def fill(url, site):
    if not url:
        return url
    repl = {
        "{lat}": str(site["lat"]), "{lon}": str(site["lon"]),
        "{name}": site["name"].replace(" ", "%20"), "{state}": site.get("state", ""),
        "{lat_min}": f"{site['lat']-BBOX_DELTA:.5f}", "{lat_max}": f"{site['lat']+BBOX_DELTA:.5f}",
        "{lon_min}": f"{site['lon']-BBOX_DELTA:.5f}", "{lon_max}": f"{site['lon']+BBOX_DELTA:.5f}",
    }
    for k, v in repl.items():
        url = url.replace(k, v)
    return url


def applicable(sources, state):
    cat_order = {c["id"]: i for i, c in enumerate(sources.get("categories", []))}
    out = []
    for s in sources["sources"]:
        st = s.get("states", ["*"])
        if st == ["*"] or state in st:
            out.append(s)
    # Group by ESS category (proforma order), national sources first, then priority.
    out.sort(key=lambda s: (cat_order.get(s["category"], 99),
                            0 if s["jurisdiction"] == "national" else 1,
                            s.get("priority", 99)))
    return out


def build(site, sources):
    state = site.get("state") or ""
    srcs = []
    for s in applicable(sources, state):
        srcs.append({
            "id": s["id"], "name": s["name"], "category": s["category"],
            "method": s["method"], "jurisdiction": s["jurisdiction"],
            "url": fill(s.get("url_template") or s.get("url"), site),
            "what_to_find": s.get("what_to_find", ""),
            "instructions": s.get("instructions", ""),
            "web_search": (s.get("web_search") or "").replace("{name}", site["name"]).replace("{state}", state).replace("{lat}", str(site["lat"])).replace("{lon}", str(site["lon"])),
            "api": s.get("api"),
            "internal": s.get("internal", False),
            "no_result_means": s.get("no_result_means", ""),
        })
    return srcs


# Categories whose cards show reference photos — the browser tool auto-fetches a
# labelled Wikipedia image per identified subject, so their log entries carry an
# `image_subjects` hint for the agent to fill (see assets/app.js).
WIKI_IMAGE_CATEGORIES = {"invasive_plants", "invasive_animals", "disease", "threatened"}

# General biosecurity obligation (GBO) under Queensland's Biosecurity Act 2014 —
# pre-seeded into the Additional Information section for QLD sites, matching the
# browser tool (assets/app.js GBO_ADDITIONAL_TEXT).
GBO_ADDITIONAL_TEXT = (
    "Under the Biosecurity Act 2014, everyone in Queensland has a general biosecurity obligation (GBO) to ensure that they do not spread a pest, disease or a contaminant. We are all responsible for managing biosecurity risks that are under our control.\n\n"
    "Under the GBO, individuals and corporations whose activities pose a biosecurity risk must:\n\n"
    "•  take all reasonable and practical steps to prevent or minimise each biosecurity risk\n"
    "•  minimise the likelihood of causing a biosecurity event, and limit the consequences if an event is caused\n"
    "• prevent or minimise the harmful effects a risk could have, and not do anything that might make any harmful effects worse.\n\n"
    "Even if you are permitted to access places under an Act, you still have a GBO to minimise biosecurity risks."
)


def findings_template(site, sources, srcs):
    """Emit the canonical ess-findings/1 skeleton for the agent to fill in.

    Same schema the browser tool imports/exports (assets/app.js reportObject).
    The agent sets each collection_log entry's status/note/result_text and each
    section's choice/note, then returns the completed object. Species/subject
    entries also carry an `image_subjects` list: fill it with the identifiable
    species/subject names when the entry is `found` and the tool auto-fetches a
    reference photo for each on import.
    """
    today = datetime.date.today().isoformat()
    gbo = GBO_ADDITIONAL_TEXT if site.get("state") == "QLD" else ""
    sections = [
        {"id": r["id"], "title": r["title"], "choice": "",
         "note": gbo if r["id"] == "additional" else "",
         "detail": ""}
        for r in sources.get("report_sections", [])
    ]
    log = []
    for s in srcs:
        entry = {"id": s["id"], "name": s["name"], "category": s["category"],
                 "jurisdiction": s["jurisdiction"], "url": s["url"],
                 "status": "unset", "note": "", "result_text": ""}
        if s["category"] in WIKI_IMAGE_CATEGORIES:
            entry["image_subjects"] = []
        log.append(entry)
    return {
        "schema": "ess-findings/1",
        "generated": today,
        "tool": "ess-collect",
        "site": {
            "name": site["name"], "station_num": site.get("station_num", ""),
            "wmo": site.get("wmo", ""), "state": site.get("state", ""),
            "delivery_group": site.get("delivery_group", ""),
            "facility_types": site.get("facility_types", []),
            "lat": site["lat"], "lon": site["lon"],
            "assessment_date": today, "site_maintenance": "",
        },
        "sections": sections,
        "collection_log": log,
    }


def run_batch(a, stations, sources):
    """Resolve a list of sites and emit one payload covering all of them.

    --template → ess-findings-batch/1 { sites: [ <ess-findings/1 skeleton>, … ] },
                 ready to fill and import into the browser tool in one go.
    --json     → the resolved payload per site (site + aimed sources), with the
                 shared dropdowns/statements/epbc_matters hoisted to the top once.
    (neither)  → a human-readable per-site summary.
    Unresolved / ambiguous lines are always reported on stderr so they are fixed
    once, up front, rather than silently dropped."""
    specs = read_batch_specs(a.batch)
    today = datetime.date.today().isoformat()
    resolved, unresolved, notes = [], [], []
    seen = set()
    for spec in specs:
        site, note = resolve_spec(spec, stations, a.state)
        if not site:
            unresolved.append((spec, note))
            continue
        key = f"num:{site['station_num']}" if site.get("station_num") else f"xy:{site['lat']:.5f},{site['lon']:.5f}"
        if key in seen:
            notes.append(f"duplicate skipped: {spec} → {site['name']}")
            continue
        seen.add(key)
        if note:
            notes.append(note)
        resolved.append(site)

    for n in notes:
        print(f"# Note: {n}", file=sys.stderr)
    for spec, why in unresolved:
        print(f"# UNRESOLVED: {why}", file=sys.stderr)
    if not resolved:
        print("No sites resolved from the batch list.", file=sys.stderr)
        sys.exit(2)
    print(f"# Resolved {len(resolved)} site(s); {len(unresolved)} unresolved.", file=sys.stderr)

    if a.template:
        out = {"schema": "ess-findings-batch/1", "generated": today, "tool": "ess-collect",
               "sites": [findings_template(s, sources, build(s, sources)) for s in resolved]}
        print(json.dumps(out, indent=2, ensure_ascii=False))
        return
    if a.json:
        out = {"schema": "ess-findings-batch/1", "generated": today, "tool": "ess-collect",
               "epbc_matters": sources.get("epbc_matters", []),
               "dropdowns": load("dropdowns.json"), "statements": load_optional("statements.json", {}),
               "sites": [{"site": s, "sources": build(s, sources)} for s in resolved]}
        print(json.dumps(out, indent=2, ensure_ascii=False))
        return

    for i, s in enumerate(resolved, 1):
        srcs = build(s, sources)
        print(f"[{i}/{len(resolved)}] {s['name']}  —  {s.get('state') or '?'}  "
              f"(station {s.get('station_num') or '—'}, {s['lat']},{s['lon']})  ·  {len(srcs)} sources")
    if unresolved:
        print(f"\n{len(unresolved)} unresolved (see stderr): " + ", ".join(u[0] for u in unresolved))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--station")
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument("--state")
    ap.add_argument("--name")
    ap.add_argument("--batch", metavar="FILE",
                    help="resolve many sites: a file with one station/number or 'lat,lon[,name]' per line "
                         "('-' reads stdin). Emits an ess-findings-batch/1 object with --template/--json.")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--template", action="store_true",
                    help="emit the ess-findings/1 skeleton to fill in and import")
    a = ap.parse_args()

    stations = load("stations.json")
    sources = load("sources.json")

    if a.batch:
        run_batch(a, stations, sources)
        return

    if a.station:
        site, hits = find_station(stations, a.station)
        if not site:
            print(f"No station matched '{a.station}'.", file=sys.stderr)
            sys.exit(2)
        if len(hits) > 1 and site["name"].lower() != a.station.strip().lower() and str(site["station_num"]) != a.station.strip():
            print(f"# Note: '{a.station}' matched {len(hits)} sites; using the top match. Others: "
                  + ", ".join(f"{h['name']} ({h['state']},{h['station_num']})" for h in hits[1:6]), file=sys.stderr)
    elif a.lat is not None and a.lon is not None:
        st = a.state or state_from_coords(a.lat, a.lon)
        site = {"name": a.name or f"Site @ {a.lat:.4f},{a.lon:.4f}", "station_num": "", "wmo": "",
                "state": st, "delivery_group": "", "facility_types": [], "primary_facility": "",
                "lat": round(a.lat, 6), "lon": round(a.lon, 6),
                "refs": {"invasive_plants": WEEDS.get(st, ""), "invasive_animals": "https://www.dcceew.gov.au/environment/invasive-species", "diseases": "https://www.outbreak.gov.au/"}}
    else:
        ap.error("provide --station OR --lat/--lon")

    srcs = build(site, sources)

    if a.template:
        print(json.dumps(findings_template(site, sources, srcs), indent=2, ensure_ascii=False))
        return

    payload = {"site": site, "sources": srcs, "epbc_matters": sources.get("epbc_matters", []),
               "dropdowns": load("dropdowns.json"),
               "statements": load_optional("statements.json", {})}

    if a.json:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return

    s = site
    print(f"SITE: {s['name']}")
    print(f"  Station #: {s.get('station_num') or '—'}   WMO: {s.get('wmo') or '—'}   State: {s.get('state') or '?'}")
    print(f"  Delivery group: {s.get('delivery_group') or '—'}   Facility: {', '.join(s.get('facility_types') or []) or s.get('primary_facility') or '—'}")
    print(f"  Lat/Long: {s['lat']}, {s['lon']}")
    print(f"\n{len(srcs)} applicable sources (work through every one; assign FOUND / NONE / FAILED / MANUAL):\n")
    cur = None
    for i, x in enumerate(srcs, 1):
        if x["category"] != cur:
            cur = x["category"]
            print(f"── {cur} ──")
        tags = []
        if x["method"] == "api":
            tags.append("API")
        if x["internal"]:
            tags.append("INTERNAL")
        tag = f" [{','.join(tags)}]" if tags else ""
        print(f"  {i:2d}. {x['name']}{tag}  ({x['method']})")
        print(f"      {x['what_to_find']}")
        print(f"      URL: {x['url']}")
        if x["web_search"]:
            print(f"      web_search: {x['web_search']}")
    print("\nStandardized proforma wording is in data/dropdowns.json, and the")
    print("narrative templates (GBO text, koala district, duty-of-care, impact")
    print("sentence) are in data/statements.json (use --json to include both).")


if __name__ == "__main__":
    main()
