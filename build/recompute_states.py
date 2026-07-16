#!/usr/bin/env python3
"""recompute_states.py — re-derive every station's `state` field geographically.

data/stations.json is normally regenerated from the BOM workbook by
build_data.py, but the raw workbook is git-ignored and not always at hand.
This applies the same fix directly to the committed JSON: recompute `state`
from each station's own lat/lon via geostate.state_from_coords() (real state
boundary polygons) instead of trusting the BOM delivery `region`, and update
the `invasive_plants` reference link for any station whose state changes.

`region` (the raw BOM delivery region) is left untouched — it's a separate,
administrative field.

Usage:
    python build/recompute_states.py [--write]

Without --write, prints a diff summary only.
"""
from __future__ import annotations
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
STATIONS_PATH = os.path.join(REPO, "data", "stations.json")

sys.path.insert(0, HERE)
from geostate import state_from_coords  # noqa: E402

STATE_WEEDS_LINK = {
    "QLD": "https://www.business.qld.gov.au/industries/farms-fishing-forestry/agriculture/biosecurity/plants/invasive/restricted",
    "NSW": "https://weeds.org.au/regions/nsw/",
    "VIC": "https://agriculture.vic.gov.au/biosecurity/weeds/weeds-information",
    "SA": "https://www.landscape.sa.gov.au/hf/landscapes-hills-and-fleurieu-stewardship-program/understand-your-responsibilities-as-a-land-manager/pest-plants-and-animals-2/pest-plants",
    "WA": "https://www.agric.wa.gov.au/pests-weeds-diseases/weeds",
    "TAS": "https://nre.tas.gov.au/invasive-species/weeds-index",
    "NT": "https://nt.gov.au/environment/weeds",
    "ACT": "https://www.environment.act.gov.au/parks-conservation/plants-and-animals/pest-plants-and-animals",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="write corrected data/stations.json (default: dry run)")
    args = ap.parse_args()

    with open(STATIONS_PATH, encoding="utf-8") as f:
        stations = json.load(f)

    changed = []
    for s in stations:
        old = s.get("state") or ""
        new = state_from_coords(s.get("lat"), s.get("lon"))
        if new and new != old:
            changed.append((s, old, new))

    print(f"{len(stations)} stations checked, {len(changed)} state corrections found.\n")
    for s, old, new in changed[:50]:
        print(f"  {s['name']} ({s.get('station_num') or '—'}): {old or '?'} -> {new}  "
              f"[{s['lat']}, {s['lon']}]  region={s.get('region') or '—'}")
    if len(changed) > 50:
        print(f"  ... and {len(changed) - 50} more")

    if not args.write:
        print("\nDry run — pass --write to apply.")
        return

    for s, old, new in changed:
        s["state"] = new
        s["refs"]["invasive_plants"] = STATE_WEEDS_LINK.get(new, "")

    with open(STATIONS_PATH, "w", encoding="utf-8") as f:
        json.dump(stations, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")

    print(f"\nWrote {len(changed)} corrections to {STATIONS_PATH}")


if __name__ == "__main__":
    main()
