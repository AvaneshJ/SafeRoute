"""
Phase 5 — Community Intelligence Engine

Turns verified (and pending) human reports into per-road safety bias
that modulates XGBoost / rule edge weights — without changing A*.

Pipeline:
  Firestore `reports` (live)  ── or ──  community_reports.csv (offline snapshot)
        ↓  spread to road centroids within SPREAD_M (linear falloff)
        ↓  weight = trust × category half-life recency × verified boost
        ↓  split into day / night layers by the hour the report was made
  community_bias.json   { bias_day: {road_id: Δ}, bias_night: {road_id: Δ} }
        ↓  applied in ml.predict.apply_safety_to_graph
  effective_safety(h) = clamp(base_safety(h) − bias(h), 0, 100)

  python -m ml.community_intelligence              # auto: Firestore if configured, else CSV
  python -m ml.community_intelligence --source csv
"""
from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path
from typing import Any, Literal

import numpy as np
import pandas as pd
from sklearn.neighbors import BallTree

ML_DIR = Path(__file__).resolve().parent
PROCESSED = ML_DIR.parent / "data" / "processed"
REPORTS_CSV = PROCESSED / "community_reports.csv"
SCORES_CSV = PROCESSED / "road_safety_scores.csv"
BIAS_JSON = PROCESSED / "community_bias.json"
GEOHASH_JSON = PROCESSED / "community_geohash_agg.json"

ReportSource = Literal["auto", "firestore", "csv"]

# Max points subtracted from a road's safety score
MAX_BIAS = 40.0
# Reports affect every road centroid within this radius, fading linearly to 0.
SPREAD_M = 150.0
EARTH_R = 6371000.0

# How long a report keeps influencing routing: weight halves every N days.
# Personal-safety incidents go stale fast; physical problems persist.
CATEGORY_HALF_LIFE_DAYS: dict[str, float] = {
    "harassment": 14.0,
    "crime": 21.0,
    "lighting": 30.0,
    "infrastructure": 60.0,
    "other": 21.0,
}
DEFAULT_HALF_LIFE_DAYS = 21.0
# Below this weight a report is ignored entirely (≈ 4–5 half-lives old).
MIN_WEIGHT = 0.05

# Local hours treated as "night" for splitting reports (19:00–06:00).
NIGHT_START_HOUR = 19
NIGHT_END_HOUR = 6
# How much a report bleeds into the other half of the day.
NIGHT_REPORT_DAY_SHARE = 0.4
DAY_REPORT_NIGHT_SHARE = 0.7


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def half_life_days(category: str | None) -> float:
    return CATEGORY_HALF_LIFE_DAYS.get(str(category or "other").lower(), DEFAULT_HALF_LIFE_DAYS)


def report_weight(
    trust_score: float = 50.0,
    age_days: float = 0.0,
    verified: bool = False,
    category: str | None = None,
) -> float:
    """Mirror core/trust.ts weightedReportContribution (simplified levels)."""
    if trust_score <= 20:
        level_w = 0.0
    elif trust_score <= 40:
        level_w = 0.25
    elif trust_score <= 60:
        level_w = 0.6
    elif trust_score <= 80:
        level_w = 1.0
    else:
        level_w = 1.4
    recency = 0.5 ** (max(0.0, age_days) / half_life_days(category))
    verified_boost = 1.5 if verified else 1.0
    return level_w * recency * verified_boost


def severity_risk(severity: float) -> float:
    """Map severity 1–5 → risk contribution in [0, 1]."""
    return max(0.0, min(1.0, (float(severity) - 1.0) / 4.0))


def is_night_hour(hour: float) -> bool:
    h = float(hour) % 24.0
    return h >= NIGHT_START_HOUR or h < NIGHT_END_HOUR


def day_night_shares(category: str | None, created_hour: float | None) -> tuple[float, float]:
    """(day_share, night_share) of a report's penalty."""
    if str(category or "").lower() == "lighting":
        # Darkness is only a hazard after dark.
        return 0.0, 1.0
    if created_hour is None or (isinstance(created_hour, float) and math.isnan(created_hour)):
        return 1.0, 1.0
    if is_night_hour(created_hour):
        return NIGHT_REPORT_DAY_SHARE, 1.0
    return 1.0, DAY_REPORT_NIGHT_SHARE


def ensure_seed_reports(path: Path = REPORTS_CSV) -> Path:
    """Create a small Mumbai seed if no community reports exist yet."""
    if path.exists() and path.stat().st_size > 40:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    now = int(time.time() * 1000)
    day = 86_400_000
    # Cluster around Andheri / Bandra corridors used in Phase 3 demos
    rows = [
        {
            "report_id": "seed-1",
            "latitude": 19.1195,
            "longitude": 72.8465,
            "category": "lighting",
            "severity": 4,
            "status": "verified",
            "trust_score": 70,
            "created_at_ms": now - 2 * day,
            "created_hour_local": 21,
            "note": "Poor street lighting after 9pm",
        },
        {
            "report_id": "seed-2",
            "latitude": 19.1188,
            "longitude": 72.8472,
            "category": "harassment",
            "severity": 5,
            "status": "verified",
            "trust_score": 75,
            "created_at_ms": now - 5 * day,
            "created_hour_local": 22,
            "note": "Verbal harassment near junction",
        },
        {
            "report_id": "seed-3",
            "latitude": 19.0901,
            "longitude": 72.8368,
            "category": "crime",
            "severity": 4,
            "status": "verified",
            "trust_score": 65,
            "created_at_ms": now - 10 * day,
            "created_hour_local": 14,
            "note": "Phone snatching reported",
        },
        {
            "report_id": "seed-4",
            "latitude": 19.0598,
            "longitude": 72.8292,
            "category": "lighting",
            "severity": 3,
            "status": "pending",
            "trust_score": 55,
            "created_at_ms": now - 1 * day,
            "created_hour_local": 20,
            "note": "Dim stretch near station approach",
        },
        {
            "report_id": "seed-5",
            "latitude": 19.1130,
            "longitude": 72.8690,
            "category": "infrastructure",
            "severity": 3,
            "status": "verified",
            "trust_score": 60,
            "created_at_ms": now - 7 * day,
            "created_hour_local": 11,
            "note": "Broken pavement, trip hazard",
        },
        {
            "report_id": "seed-6",
            "latitude": 19.0175,
            "longitude": 72.8475,
            "category": "crime",
            "severity": 4,
            "status": "verified",
            "trust_score": 80,
            "created_at_ms": now - 3 * day,
            "created_hour_local": 23,
            "note": "Unsafe after dark — multiple reports",
        },
    ]
    pd.DataFrame(rows).to_csv(path, index=False)
    print(f"  seeded {len(rows)} demo reports -> {path}", flush=True)
    return path


def load_reports(
    source: ReportSource = "auto",
    reports_path: Path = REPORTS_CSV,
    snapshot: bool = True,
) -> tuple[pd.DataFrame, str]:
    """
    Returns (reports, source_used).

    Firestore results are written to `reports_path` as an offline snapshot so a
    host without credentials (or a cold start) still routes on recent data.
    """
    if source in ("auto", "firestore"):
        from .firestore_reports import fetch_firestore_reports, firestore_configured

        if firestore_configured():
            df = fetch_firestore_reports()
            if snapshot:
                reports_path.parent.mkdir(parents=True, exist_ok=True)
                df.to_csv(reports_path, index=False)
            return df, "firestore"
        if source == "firestore":
            raise RuntimeError("Firestore credentials not configured (see ml/firestore_reports.py)")

    ensure_seed_reports(reports_path)
    return pd.read_csv(reports_path), "csv"


def build_community_bias(
    reports_path: Path = REPORTS_CSV,
    scores_path: Path = SCORES_CSV,
    bias_path: Path = BIAS_JSON,
    geohash_path: Path = GEOHASH_JSON,
    *,
    source: ReportSource = "csv",
    reports: pd.DataFrame | None = None,
) -> dict[str, Any]:
    t0 = time.time()
    if reports is None:
        reports, source_used = load_reports(source, reports_path)
    else:
        source_used = source

    required = {"latitude", "longitude", "severity"}
    missing = required - set(reports.columns)
    if missing:
        raise ValueError(f"community reports missing {missing}")

    scores = pd.read_csv(scores_path, dtype={"road_id": str}, usecols=["road_id", "latitude", "longitude"])
    road_xy = np.radians(scores[["latitude", "longitude"]].astype(float).values)
    tree = BallTree(road_xy, metric="haversine")
    road_ids = scores["road_id"].astype(str).values

    now_ms = int(time.time() * 1000)
    bias_day: dict[str, float] = {}
    bias_night: dict[str, float] = {}
    geohash_acc: dict[str, dict[str, float]] = {}
    by_category: dict[str, int] = {}

    used = 0
    for _, row in reports.iterrows():
        status = str(row.get("status", "pending")).lower()
        if status in ("rejected", "expired", "spam"):
            continue
        lat, lon = float(row["latitude"]), float(row["longitude"])
        severity = float(row["severity"])
        category = str(row.get("category", "other") or "other").lower()
        trust = float(row.get("trust_score", 50) or 50)
        created = float(row.get("created_at_ms", now_ms) or now_ms)
        age_days = max(0.0, (now_ms - created) / 86_400_000.0)
        verified = status == "verified"
        w = report_weight(trust, age_days, verified, category)
        if w < MIN_WEIGHT:
            continue

        idx, dist = tree.query_radius(
            np.radians([[lat, lon]]), r=SPREAD_M / EARTH_R, return_distance=True
        )
        if len(idx[0]) == 0:
            continue
        hour_raw = row.get("created_hour_local")
        hour = float(hour_raw) if hour_raw is not None and not pd.isna(hour_raw) else None
        day_share, night_share = day_night_shares(category, hour)
        delta = w * severity_risk(severity) * MAX_BIAS
        for road_i, d_rad in zip(idx[0], dist[0]):
            proximity = max(0.0, 1.0 - float(d_rad) * EARTH_R / SPREAD_M)
            rid = str(road_ids[int(road_i)])
            if day_share > 0:
                bias_day[rid] = min(MAX_BIAS, bias_day.get(rid, 0.0) + delta * day_share * proximity)
            if night_share > 0:
                bias_night[rid] = min(
                    MAX_BIAS, bias_night.get(rid, 0.0) + delta * night_share * proximity
                )
        used += 1
        by_category[category] = by_category.get(category, 0) + 1

        # Coarse geohash-ish key for cell aggregates (0.01° ≈ 1 km)
        cell = f"{round(lat, 2)}_{round(lon, 2)}"
        g = geohash_acc.setdefault(
            cell,
            {
                "lat": round(lat, 2),
                "lon": round(lon, 2),
                "weight": 0.0,
                "rating_mass": 0.0,
                "incidents": 0.0,
                "reports": 0.0,
            },
        )
        rating = 6.0 - severity  # stars
        g["weight"] += w
        g["rating_mass"] += w * rating
        g["reports"] += 1
        if severity >= 4:
            g["incidents"] += w

    def _rounded(d: dict[str, float]) -> dict[str, float]:
        return {k: round(v, 2) for k, v in sorted(d.items(), key=lambda x: -x[1]) if v >= 0.05}

    day_out, night_out = _rounded(bias_day), _rounded(bias_night)
    combined = {k: max(day_out.get(k, 0.0), night_out.get(k, 0.0)) for k in {*day_out, *night_out}}
    bias_out = {
        "version": 2,
        "generated_at_ms": now_ms,
        "source": source_used,
        "spread_m": SPREAD_M,
        "max_bias": MAX_BIAS,
        "half_life_days": CATEGORY_HALF_LIFE_DAYS,
        "night_hours": [NIGHT_START_HOUR, NIGHT_END_HOUR],
        "reports_total": int(len(reports)),
        "reports_used": used,
        "reports_by_category": by_category,
        "roads_affected": len(combined),
        # Back-compat: worst of day/night for readers that predate v2.
        "bias": dict(sorted(combined.items(), key=lambda x: -x[1])),
        "bias_day": day_out,
        "bias_night": night_out,
    }
    bias_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = bias_path.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(bias_out, f, indent=2)
    tmp.replace(bias_path)

    cells = []
    for cell, g in geohash_acc.items():
        w = g["weight"] or 1.0
        cells.append(
            {
                "cell": cell,
                "latitude": g["lat"],
                "longitude": g["lon"],
                "communityRating": round(g["rating_mass"] / w, 2),
                "verifiedIncidents30d": round(g["incidents"], 2),
                "historicalReports": int(g["reports"]),
            }
        )
    with geohash_path.open("w", encoding="utf-8") as f:
        json.dump({"cells": cells, "generated_at_ms": now_ms}, f, indent=2)

    meta = {
        "source": source_used,
        "reports_total": int(len(reports)),
        "reports_used": used,
        "roads_affected": len(combined),
        "roads_affected_day": len(day_out),
        "roads_affected_night": len(night_out),
        "cells": len(cells),
        "built_s": round(time.time() - t0, 2),
        "generated_at_ms": now_ms,
        "bias_path": str(bias_path),
    }
    print(
        f"  community bias ({source_used}): {used}/{len(reports)} reports -> "
        f"{len(day_out)} day / {len(night_out)} night roads, "
        f"{len(cells)} cells ({meta['built_s']}s)",
        flush=True,
    )
    return meta


def sync_community_bias(source: ReportSource = "auto") -> dict[str, Any]:
    """Fetch the latest reports and rebuild community_bias.json."""
    reports, used = load_reports(source)
    return build_community_bias(source=used, reports=reports)  # type: ignore[arg-type]


def load_community_bias_layers(path: Path = BIAS_JSON) -> tuple[dict[str, float], dict[str, float]]:
    """(day, night) bias maps. v1 files apply the same bias at all hours."""
    if not path.exists():
        return {}, {}
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    if "bias_day" in data or "bias_night" in data:
        day = {str(k): float(v) for k, v in (data.get("bias_day") or {}).items()}
        night = {str(k): float(v) for k, v in (data.get("bias_night") or {}).items()}
        return day, night
    flat = {str(k): float(v) for k, v in (data.get("bias") or {}).items()}
    return flat, dict(flat)


def load_community_bias(path: Path = BIAS_JSON) -> dict[str, float]:
    day, night = load_community_bias_layers(path)
    return {k: max(day.get(k, 0.0), night.get(k, 0.0)) for k in {*day, *night}}


def apply_bias_to_score(base_safety: float, bias: float) -> float:
    return float(max(0.0, min(100.0, float(base_safety) - float(bias))))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", choices=["auto", "firestore", "csv"], default="auto")
    args = parser.parse_args()
    sync_community_bias(args.source)


if __name__ == "__main__":
    main()
