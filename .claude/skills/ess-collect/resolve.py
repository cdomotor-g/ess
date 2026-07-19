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
import argparse, datetime, json, os, sys

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
    sections = [
        {"id": r["id"], "title": r["title"], "choice": "", "note": "",
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--station")
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument("--state")
    ap.add_argument("--name")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--template", action="store_true",
                    help="emit the ess-findings/1 skeleton to fill in and import")
    a = ap.parse_args()

    stations = load("stations.json")
    sources = load("sources.json")

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
