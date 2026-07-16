#!/usr/bin/env python3
"""geostate.py — resolve an Australian state/territory code from a lat/lon.

State-specific external tool lookups (NSW BioNet vs QLD WildNet, etc.) need
the state a site is *geographically* in, not the BOM administrative
delivery region it happens to be serviced by — those disagree right along
state borders (e.g. an NSW-serviced flood gauge that sits just inside QLD).

This resolves against real state boundary polygons
(data/reference/au_states.geojson — Natural Earth 1:10m admin-1, public
domain) with a point-in-polygon test, falling back to nearest-boundary
vertex for points just outside the coastline (docks, reclaimed land,
vector-simplification gaps), and finally a coarse bounding-box heuristic if
the boundary file can't be loaded at all.

Shared by build/build_data.py (build-time) and
.claude/skills/ess-collect/resolve.py (runtime CLI); assets/app.js carries
an equivalent JS implementation for the browser tool.
"""
from __future__ import annotations
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
BOUNDARIES_PATH = os.path.join(REPO, "data", "reference", "au_states.geojson")

# Natural Earth admin-1 feature names -> the state/territory code the rest of
# this repo keys sources/links on. Minor islands + federal enclaves map to
# their governing/nearest state.
NAME_TO_STATE = {
    "Western Australia": "WA",
    "Northern Territory": "NT",
    "South Australia": "SA",
    "Queensland": "QLD",
    "New South Wales": "NSW",
    "Victoria": "VIC",
    "Tasmania": "TAS",
    "Australian Capital Territory": "ACT",
    "Jervis Bay Territory": "NSW",        # federal enclave inside NSW
    "Lord Howe Island": "NSW",            # part of NSW
    "Macquarie Island": "TAS",            # part of Tasmania
    "Ashmore and Cartier Islands": "WA",  # nearest state jurisdiction
}

# Last-resort fallback only, for points outside the boundary dataset's
# coverage entirely (or if the file is missing). Heuristic, boxes overlap
# near borders — do not use this for anything the polygon test can answer.
STATE_BBOXES = [
    ("ACT", -35.92, -35.12, 148.76, 149.40),
    ("TAS", -43.75, -39.10, 143.80, 148.55),
    ("VIC", -39.20, -33.98, 140.96, 150.05),
    ("NSW", -37.51, -28.16, 140.99, 153.64),
    ("QLD", -29.18, -9.90, 137.99, 153.55),
    ("SA", -38.10, -25.99, 128.99, 141.02),
    ("NT", -26.01, -10.90, 128.99, 138.02),
    ("WA", -35.20, -13.68, 112.90, 129.02),
]

_polygons = None  # cached [(state_code, [poly, ...])], poly = [ring, ...], ring = [[lon,lat], ...]


def _load_polygons():
    global _polygons
    if _polygons is not None:
        return _polygons
    _polygons = []
    try:
        with open(BOUNDARIES_PATH, encoding="utf-8") as f:
            gj = json.load(f)
        for feat in gj["features"]:
            code = NAME_TO_STATE.get(feat.get("properties", {}).get("name"))
            if not code:
                continue
            geom = feat["geometry"]
            polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
            _polygons.append((code, polys))
    except (OSError, ValueError, KeyError):
        _polygons = []
    return _polygons


def _point_in_ring(x, y, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def _point_in_polygon(x, y, poly):
    if not _point_in_ring(x, y, poly[0]):
        return False
    return not any(_point_in_ring(x, y, hole) for hole in poly[1:])


# Cap on the nearest-vertex fallback, in degrees. Real near-miss cases (a
# station on a jetty, reclaimed land, or a coastline simplification gap) land
# a small fraction of a degree from the actual boundary; anything further out
# is more likely a bad/garbled coordinate than a genuine offshore site, and
# guessing a state for it would be worse than leaving it unresolved.
_NEAREST_MAX_DEG = 3.0


def _nearest_state(x, y, polygons):
    best_code, best_d2 = "", float("inf")
    for code, polys in polygons:
        for poly in polys:
            for ring in poly:
                for px, py in ring:
                    d2 = (px - x) ** 2 + (py - y) ** 2
                    if d2 < best_d2:
                        best_d2, best_code = d2, code
    if best_d2 > _NEAREST_MAX_DEG * _NEAREST_MAX_DEG:
        return ""
    return best_code


def _state_from_bbox(lat, lon):
    for code, s, n, w, e in STATE_BBOXES:
        if s <= lat <= n and w <= lon <= e:
            return code
    return ""


def state_from_coords(lat, lon):
    """Best-effort geographic state code for a coordinate. Returns '' if unknown."""
    if lat is None or lon is None:
        return ""
    try:
        lat = float(lat)
        lon = float(lon)
    except (TypeError, ValueError):
        return ""
    polygons = _load_polygons()
    if polygons:
        for code, polys in polygons:
            for poly in polys:
                if _point_in_polygon(lon, lat, poly):
                    return code
        nearest = _nearest_state(lon, lat, polygons)
        if nearest:
            return nearest
    return _state_from_bbox(lat, lon)
