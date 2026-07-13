#!/usr/bin/env python3
"""
merge_fred_stations.py — Union the BOM "FReD" (FWIN Register e-Database)
export into data/stations.json.

Why this exists
----------------
FReD is the Bureau's live register of Flood Warning Infrastructure Network
sites — including partner/council-owned gauges under assessment that have
never made it into the FWIN ESS Template workbook build_data.py consumes.
Comparing a FReD export against the current data/stations.json turns up
sites this tool doesn't know about yet.

FReD has no latitude/longitude column, and the whole tool is coordinate-driven
(every source deep-link and the ALA query needs lat/lon), so a second,
independent station list — a "MegaNet" radio-planning database — is used to
backfill coordinates by name where it unambiguously can. MegaNet station names
are truncated to 20 characters (a Radio Mobile field-length limit), so the
match key is "does the FReD name, truncated to 20 chars, exactly equal a
MegaNet name" — a deterministic consequence of truncation, not a fuzzy guess.
Only matches that resolve to one distinct coordinate pair are accepted;
anything ambiguous (or absent from MegaNet) is added with lat/lon left blank
rather than guessed, since a wrong coordinate is worse than a missing one for
a tool that aims people at a real site.

Usage
-----
    python build/merge_fred_stations.py \
        --fred build/source/FReD.csv \
        --meganet build/source/meganet_stations.json \
        --stations data/stations.json \
        --meta data/meta.json

Both --fred and --meganet are optional inputs (git-ignored, dropped into
build/source/ like the internal workbook); the script no-ops cleanly if either
is missing. Output is sorted and deterministic, same convention as
build_data.py, for a clean reviewable git diff.
"""
from __future__ import annotations

import argparse
import collections
import csv
import datetime as _dt
import hashlib
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_data import (  # noqa: E402
    STATE_WEEDS_LINK,
    NATIONAL_INVASIVE_ANIMALS_LINK,
    NATIONAL_OUTBREAK_LINK,
    clean_num,
    write_json,
)


def norm(s):
    return re.sub(r"[^A-Z0-9]", "", s.upper())


def refs_for_state(state):
    return {
        "invasive_plants": STATE_WEEDS_LINK.get(state, ""),
        "invasive_animals": NATIONAL_INVASIVE_ANIMALS_LINK,
        "diseases": NATIONAL_OUTBREAK_LINK,
    }


def load_fred(path):
    """One row per unique Station Number (first occurrence wins)."""
    by_num = collections.OrderedDict()
    dup_numbers = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            num = (row.get("Station Number") or "").strip()
            if not num:
                continue
            if num in by_num:
                dup_numbers.append(num)
                continue
            by_num[num] = row
    return by_num, dup_numbers


def load_meganet_coords(path):
    """Truncated-name (<=20 chars, the Radio Mobile field limit) -> set of
    distinct (lat, lon) pairs seen for that key. Only keys with exactly one
    distinct pair are usable as an unambiguous coordinate source."""
    with open(path, encoding="utf-8") as f:
        mega = json.load(f)
    by_key = collections.defaultdict(set)
    for s in mega.get("stations", []):
        name = (s.get("name") or "").strip()
        lat, lon = s.get("lat"), s.get("lon")
        if not name or lat is None or lon is None:
            continue
        by_key[name.lower()].add((round(float(lat), 6), round(float(lon), 6)))
    return by_key


def build_record(row, coord):
    name = re.sub(r"\s+", " ", (row.get("Station Name") or "").strip()).upper()
    state = (row.get("State") or "").strip().upper()
    facility_str = (row.get("Location Types") or "").strip()
    facility_types = sorted({t.strip() for t in facility_str.split("/") if t.strip()})
    primary = facility_str.split("/")[0].strip() if facility_str else ""
    lat, lon = (coord if coord else (None, None))
    sources = ["FReD"]
    if coord:
        sources.append("MegaNet")
    return {
        "name": name,
        "station_num": clean_num(row.get("Station Number")),
        "wmo": "",
        "region": state,
        "state": state,
        "delivery_group": (row.get("Hub") or "").strip(),
        "facility_types": facility_types,
        "primary_facility": primary,
        "lat": lat,
        "lon": lon,
        "operating_authority": (row.get("Station Owners") or "").strip(),
        "ident": "",
        "refs": refs_for_state(state),
        "sources": sources,
    }


def merge(stations, fred_by_num, mega_coords):
    existing_nums = {s["station_num"] for s in stations if s["station_num"]}
    name_index = collections.defaultdict(list)
    for s in stations:
        name_index[norm(s["name"])].append(s)

    added, skipped_name_collision, with_coords = [], [], 0
    for num, row in fred_by_num.items():
        if num in existing_nums:
            continue
        fred_name = (row.get("Station Name") or "").strip()
        fred_state = (row.get("State") or "").strip().upper()
        # A same-name match only means "same station" if it's also the same
        # state — common place names (e.g. "Crystal Brook") recur across
        # states as genuinely different sites, so state must agree too.
        same_state_hit = [s for s in name_index.get(norm(fred_name), []) if s["state"] == fred_state]
        if same_state_hit:
            skipped_name_collision.append((num, fred_name))
            continue

        key = fred_name[:20].strip().lower()
        candidates = mega_coords.get(key)
        coord = None
        if candidates and len(candidates) == 1:
            coord = next(iter(candidates))
            with_coords += 1

        rec = build_record(row, coord)
        added.append(rec)

    merged = stations + added
    merged.sort(key=lambda r: (r["name"], r["station_num"]))
    for r in merged:
        r["facility_types"].sort()
    return merged, added, skipped_name_collision, with_coords


def update_meta(meta_path, merged, added, with_coords, fred_path, meganet_path):
    if not os.path.exists(meta_path):
        return
    with open(meta_path, encoding="utf-8") as f:
        meta = json.load(f)

    by_state = collections.Counter(s["state"] or "?" for s in merged)
    by_type = collections.Counter(t for s in merged for t in s["facility_types"])
    meta["station_count"] = len(merged)
    meta["stations_by_state"] = dict(sorted(by_state.items()))
    meta["stations_by_facility_type"] = dict(sorted(by_type.items()))

    with open(fred_path, "rb") as f:
        fred_sha256 = hashlib.sha256(f.read()).hexdigest()

    meta.setdefault("supplemental_merges", []).append({
        "merged_utc": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_file": os.path.basename(fred_path),
        "source_sha256": fred_sha256,
        "coord_source_file": os.path.basename(meganet_path) if meganet_path else None,
        "stations_added": len(added),
        "added_with_coords": with_coords,
        "added_without_coords": len(added) - with_coords,
        "builder": "build/merge_fred_stations.py",
    })

    write_json(meta_path, meta)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fred", default="build/source/FReD.csv")
    ap.add_argument("--meganet", default="build/source/meganet_stations.json")
    ap.add_argument("--stations", default="data/stations.json")
    ap.add_argument("--meta", default="data/meta.json")
    args = ap.parse_args()

    if not os.path.exists(args.fred):
        sys.exit(f"FReD export not found: {args.fred}\nDrop the FReD.csv export into build/source/ and re-run.")

    with open(args.stations, encoding="utf-8") as f:
        stations = json.load(f)

    fred_by_num, dup_numbers = load_fred(args.fred)
    mega_coords = load_meganet_coords(args.meganet) if os.path.exists(args.meganet) else {}

    merged, added, skipped, with_coords = merge(stations, fred_by_num, mega_coords)

    write_json(args.stations, merged, compact=True)
    update_meta(args.meta, merged, added, with_coords, args.fred, args.meganet if os.path.exists(args.meganet) else None)

    print("FReD merge complete")
    print(f"  FReD stations (unique numbers): {len(fred_by_num)}")
    if dup_numbers:
        print(f"  duplicate station numbers in FReD (first kept): {len(dup_numbers)}")
    print(f"  already known:                 {len(fred_by_num) - len(added) - len(skipped)}")
    print(f"  skipped (name matches an existing station under a different number): {len(skipped)}")
    for num, name in skipped:
        print(f"    {num}  {name}")
    print(f"  added:                          {len(added)}")
    print(f"    with coordinates (MegaNet):  {with_coords}")
    print(f"    without coordinates:         {len(added) - with_coords}")
    print(f"  stations.json total:            {len(merged)}")


if __name__ == "__main__":
    main()
