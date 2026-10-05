"""
Phase 6 — Time-aware risk + temporary hazard decay.

Edge safety(h) = lerp(safety_day, safety_night, night_factor(h)) − hazard_penalty
Risk_final     = (1 − safety(h)/100) × TimeWeight(h)
Hazard weight  = exp(−λ t)  (half-life ≈ 36 h → ~60% at 24 h, ~20% at 72 h)
"""
from __future__ import annotations

import math
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import json

PROCESSED = Path(__file__).resolve().parents[1] / "data" / "processed"
HAZARDS_JSON = PROCESSED / "temporary_hazards.json"

# exp(−λ·24h) ≈ 0.60  →  λ = −ln(0.60)/24
HAZARD_LAMBDA_PER_HOUR = -math.log(0.60) / 24.0
HAZARD_EXPIRE_HOURS = 168.0  # 7 days

# Feature weights (lighting, police proximity, 1 − crime). The static CSV score
# uses 0.35/0.35/0.30; by day lighting barely matters, after dark it dominates.
DAY_WEIGHTS = (0.15, 0.40, 0.45)
NIGHT_WEIGHTS = (0.45, 0.30, 0.25)
STATIC_WEIGHTS = (0.35, 0.35, 0.30)

# Mumbai twilight (IST): dark ≈ 19:00–05:30 year-round within ±30 min.
DUSK_START, DUSK_END = 17.5, 19.5
DAWN_START, DAWN_END = 5.0, 7.0


def current_local_hour() -> float:
    from ml.local_time import local_hour_now

    return local_hour_now()


def night_factor(hour: float | None = None) -> float:
    """0 in daylight, 1 after dark, linear ramps across dusk and dawn."""
    h = (current_local_hour() if hour is None else float(hour)) % 24.0
    if DAWN_END <= h <= DUSK_START:
        return 0.0
    if DUSK_START < h < DUSK_END:
        return (h - DUSK_START) / (DUSK_END - DUSK_START)
    if DAWN_START < h < DAWN_END:
        return 1.0 - (h - DAWN_START) / (DAWN_END - DAWN_START)
    return 1.0


def edge_safety_at(attrs: Any, nf: float) -> float:
    """Safety of one edge for a given night_factor, including active hazards."""
    day = getattr(attrs, "safety_day", None)
    night = getattr(attrs, "safety_night", None)
    if day is None or night is None:
        s = float(attrs.safety)
    else:
        s = float(day) + float(nf) * (float(night) - float(day))
    penalty = float(getattr(attrs, "hazard_penalty", 0.0) or 0.0)
    return max(0.0, min(100.0, s - penalty))


def time_weight(hour: float | None = None) -> float:
    """
    Piecewise night risk multiplier (hour in [0, 24)).

    8 AM → 1.0, 6 PM → 1.1, 10 PM → 1.35, 1 AM → 1.55
    """
    if hour is None:
        hour = current_local_hour()
    h = float(hour) % 24.0

    # Anchor points (hour, weight)
    anchors = [
        (0.0, 1.50),
        (1.0, 1.55),
        (4.0, 1.45),
        (6.0, 1.20),
        (8.0, 1.00),
        (12.0, 1.00),
        (17.0, 1.05),
        (18.0, 1.10),
        (20.0, 1.20),
        (22.0, 1.35),
        (24.0, 1.50),
    ]
    for i in range(len(anchors) - 1):
        h0, w0 = anchors[i]
        h1, w1 = anchors[i + 1]
        if h0 <= h <= h1:
            t = 0.0 if h1 == h0 else (h - h0) / (h1 - h0)
            return w0 + t * (w1 - w0)
    return 1.0


def ml_risk(safety_0_100: float) -> float:
    return max(0.0, min(1.0, 1.0 - float(safety_0_100) / 100.0))


def final_risk(safety_0_100: float, hour: float | None = None) -> float:
    """Risk_final = Risk_ML × TimeWeight (clamped to [0, 1.8] then into cost)."""
    return ml_risk(safety_0_100) * time_weight(hour)


def time_adjusted_safety(safety_0_100: float, hour: float | None = None) -> float:
    """Convert time-scaled risk back to a 0–100 safety score for display / A*."""
    r = final_risk(safety_0_100, hour)
    # Allow risk > 1 at night → safety can drop below 0 floor
    return float(max(0.0, min(100.0, 100.0 * (1.0 - min(r, 1.0)))))


def hazard_decay_weight(age_hours: float, lam: float = HAZARD_LAMBDA_PER_HOUR) -> float:
    """Weight = e^(−λt). Expires after HAZARD_EXPIRE_HOURS."""
    if age_hours < 0:
        age_hours = 0.0
    if age_hours >= HAZARD_EXPIRE_HOURS:
        return 0.0
    return math.exp(-lam * age_hours)


@dataclass
class TemporaryHazard:
    hazard_id: str
    latitude: float
    longitude: float
    category: str
    severity: int  # 1–5
    note: str
    created_at_ms: int
    verified: bool = True
    radius_m: float = 180.0

    def age_hours(self, now_ms: int | None = None) -> float:
        now = now_ms if now_ms is not None else int(time.time() * 1000)
        return max(0.0, (now - self.created_at_ms) / 3_600_000.0)

    def weight(self, now_ms: int | None = None) -> float:
        return hazard_decay_weight(self.age_hours(now_ms))

    def active(self, now_ms: int | None = None) -> bool:
        return self.weight(now_ms) > 0.05

    def to_dict(self) -> dict[str, Any]:
        return {
            "hazard_id": self.hazard_id,
            "latitude": self.latitude,
            "longitude": self.longitude,
            "category": self.category,
            "severity": self.severity,
            "note": self.note,
            "created_at_ms": self.created_at_ms,
            "verified": self.verified,
            "radius_m": self.radius_m,
            "weight": round(self.weight(), 3),
        }


_hazards: list[TemporaryHazard] = []


def load_hazards(path: Path = HAZARDS_JSON) -> list[TemporaryHazard]:
    global _hazards
    if not path.exists():
        _hazards = []
        return _hazards
    with path.open(encoding="utf-8") as f:
        raw = json.load(f)
    items = raw if isinstance(raw, list) else raw.get("hazards", [])
    _hazards = [
        TemporaryHazard(
            hazard_id=str(h["hazard_id"]),
            latitude=float(h["latitude"]),
            longitude=float(h["longitude"]),
            category=str(h.get("category", "other")),
            severity=int(h.get("severity", 3)),
            note=str(h.get("note", "")),
            created_at_ms=int(h.get("created_at_ms", 0)),
            verified=bool(h.get("verified", True)),
            radius_m=float(h.get("radius_m", 180)),
        )
        for h in items
    ]
    # Drop expired
    _hazards = [h for h in _hazards if h.active()]
    return _hazards


def save_hazards(path: Path = HAZARDS_JSON) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump({"hazards": [h.to_dict() for h in _hazards if h.active()]}, f, indent=2)


def add_hazard(
    latitude: float,
    longitude: float,
    category: str = "harassment",
    severity: int = 4,
    note: str = "",
    verified: bool = True,
    radius_m: float = 180.0,
) -> TemporaryHazard:
    load_hazards()
    h = TemporaryHazard(
        hazard_id=str(uuid.uuid4())[:12],
        latitude=float(latitude),
        longitude=float(longitude),
        category=str(category),
        severity=max(1, min(5, int(severity))),
        note=str(note or "Temporary community hazard"),
        created_at_ms=int(time.time() * 1000),
        verified=verified,
        radius_m=float(radius_m),
    )
    _hazards.append(h)
    save_hazards()
    return h


def active_hazards() -> list[TemporaryHazard]:
    load_hazards()
    return [h for h in _hazards if h.active()]


def hazard_bias_near(
    lat: float, lon: float, hazards: list[TemporaryHazard] | None = None
) -> float:
    """
    Extra safety penalty (0–35) from nearby active hazards.
    Uses severity × decay weight × proximity.
    """
    from .astar_router import haversine_m

    items = hazards if hazards is not None else active_hazards()
    penalty = 0.0
    for h in items:
        d = haversine_m(lat, lon, h.latitude, h.longitude)
        if d > h.radius_m:
            continue
        prox = 1.0 - d / h.radius_m
        severity_f = (h.severity - 1) / 4.0
        penalty += 35.0 * severity_f * h.weight() * prox
    return min(35.0, penalty)
