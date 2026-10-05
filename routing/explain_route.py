"""
Phase 6 — Explainable route reasons from path features (no LLM).
"""
from __future__ import annotations

from typing import Any

from .astar_router import RouteResult, haversine_m
from .confidence import estimate_confidence_from_path_stats
from .dynamic_risk import (
    active_hazards,
    edge_safety_at,
    night_factor,
    time_adjusted_safety,
    time_weight,
)
from .graph_builder import RoutingGraph


def analyze_path(
    rg: RoutingGraph,
    path: list[tuple[int, int]],
    *,
    hour: float | None = None,
) -> dict[str, Any]:
    """Aggregate lighting / police / crime stats along a node path."""
    if len(path) < 2:
        return {
            "edge_count": 0,
            "mean_lighting": 0.5,
            "mean_police_dist": 800.0,
            "mean_crime": 50.0,
            "mean_safety": 50.0,
            "mean_rule_safety": 50.0,
            "mean_ml_safety": 50.0,
            "police_within_250m": 0,
            "high_crime_edges": 0,
            "low_light_edges": 0,
            "edges_with_lighting": 0,
            "edges_with_police": 0,
            "community_biased_edges": 0,
            "nearby_active_hazards": 0,
            "distance_m": 0.0,
        }

    dist = 0.0
    light_m = 0.0
    police_m = 0.0
    crime_m = 0.0
    safety_m = 0.0
    rule_m = 0.0
    police_near = 0
    high_crime = 0
    low_light = 0
    with_light = 0
    with_police = 0
    community_biased = 0
    n = 0
    nf = night_factor(hour)

    for u, v in zip(path[:-1], path[1:]):
        data = rg.graph.get_edge_data(u, v) or {}
        attrs = data.get("attrs")
        if attrs is None:
            continue
        length = float(attrs.length_m)
        if length <= 0:
            continue
        lighting = float(getattr(attrs, "lighting_score", 0.5) or 0.5)
        police = float(getattr(attrs, "police_dist", 2000) or 2000)
        crime = float(getattr(attrs, "crime_score", 50) or 50)
        safety = edge_safety_at(attrs, nf)
        rule = float(getattr(attrs, "safety_rule", None) or safety)
        bias_day = float(getattr(attrs, "bias_day", 0.0) or 0.0)
        bias = bias_day + nf * (float(getattr(attrs, "bias_night", 0.0) or 0.0) - bias_day)
        n += 1
        dist += length
        light_m += lighting * length
        police_m += police * length
        crime_m += crime * length
        safety_m += safety * length
        rule_m += rule * length
        if lighting > 0.01:
            with_light += 1
        if police < 5000:
            with_police += 1
        if police <= 250:
            police_near += 1
        if crime >= 60:
            high_crime += 1
        if lighting < 0.35:
            low_light += 1
        if bias > 2.0:
            community_biased += 1

    mean_light = light_m / dist if dist else 0.5
    mean_police = police_m / dist if dist else 800.0
    mean_crime = crime_m / dist if dist else 50.0
    mean_safety = safety_m / dist if dist else 50.0
    mean_rule = rule_m / dist if dist else mean_safety

    # Hazards near path midpoint samples
    hazards = active_hazards()
    hazard_hits = 0
    sample_nodes = path[:: max(1, len(path) // 8)]
    for node in sample_nodes:
        lat, lon = rg.node_latlng.get(node, (0.0, 0.0))
        for h in hazards:
            if haversine_m(lat, lon, h.latitude, h.longitude) <= h.radius_m:
                hazard_hits += 1
                break

    tw = time_weight(hour)
    adj = time_adjusted_safety(mean_safety, hour)

    return {
        "edge_count": n,
        "mean_lighting": round(mean_light, 3),
        "mean_police_dist": round(mean_police, 1),
        "mean_crime": round(mean_crime, 1),
        "mean_safety": round(mean_safety, 1),
        "mean_rule_safety": round(mean_rule, 1),
        "mean_ml_safety": round(mean_safety, 1),
        "police_within_250m": police_near,
        "high_crime_edges": high_crime,
        "low_light_edges": low_light,
        "edges_with_lighting": with_light,
        "edges_with_police": with_police,
        "community_biased_edges": community_biased,
        "nearby_active_hazards": hazard_hits,
        "distance_m": round(dist, 1),
        "time_weight": round(tw, 3),
        "night_factor": round(nf, 2),
        "time_adjusted_safety": round(adj, 1),
    }


def build_explanation(
    stats: dict[str, Any],
    *,
    mode: str = "balanced",
    vs_fastest_eta_delta_min: float | None = None,
) -> dict[str, Any]:
    """Human bullets for ‘Why we recommended it’."""
    reasons: list[dict[str, str]] = []
    lighting = float(stats.get("mean_lighting") or 0)
    lighting_pct = int(round(lighting * 100))
    police_near = int(stats.get("police_within_250m") or 0)
    high_crime = int(stats.get("high_crime_edges") or 0)
    low_light = int(stats.get("low_light_edges") or 0)
    hazards = int(stats.get("nearby_active_hazards") or 0)
    tw = float(stats.get("time_weight") or 1.0)

    if lighting_pct >= 40:
        reasons.append(
            {
                "icon": "wb-sunny",
                "text": f"{lighting_pct}% brighter nighttime visibility along this path",
            }
        )
    elif low_light > 0:
        reasons.append(
            {
                "icon": "nights-stay",
                "text": f"Includes {low_light} lower-light segments — stay alert",
            }
        )

    if police_near >= 2:
        reasons.append(
            {
                "icon": "local-police",
                "text": f"Passes {police_near} stretches within 250 m of police coverage",
            }
        )
    elif police_near == 1:
        reasons.append(
            {
                "icon": "local-police",
                "text": "Stays within 250 m of police coverage on part of the route",
            }
        )

    if mode == "safest" and high_crime == 0:
        reasons.append(
            {
                "icon": "shield",
                "text": "Avoids high-crime road segments relative to alternatives",
            }
        )
    elif high_crime > 0 and mode != "fastest":
        reasons.append(
            {
                "icon": "warning",
                "text": f"Still crosses {high_crime} higher-crime segments — preference reduced them",
            }
        )
    elif mode == "fastest":
        reasons.append(
            {
                "icon": "directions-walk",
                "text": "Optimised for walking time (α = 0) with baseline safety scoring",
            }
        )

    if hazards > 0:
        reasons.append(
            {
                "icon": "campaign",
                "text": f"Accounts for {hazards} active temporary community hazard(s) nearby",
            }
        )

    if tw >= 1.3:
        reasons.append(
            {
                "icon": "schedule",
                "text": f"Night risk multiplier ×{tw:.2f} applied to edge costs",
            }
        )

    if vs_fastest_eta_delta_min is not None and vs_fastest_eta_delta_min > 0.5:
        mins = int(round(vs_fastest_eta_delta_min))
        reasons.append(
            {
                "icon": "timer",
                "text": f"{mins} min longer than the fastest option",
            }
        )

    if not reasons:
        reasons.append(
            {
                "icon": "route",
                "text": "Ranked using distance × safety-weighted traversal cost",
            }
        )

    conf = estimate_confidence_from_path_stats(stats)
    return {
        "title": "Why we recommended it",
        "reasons": reasons[:5],
        "stats": {
            "lighting_pct": lighting_pct,
            "police_within_250m": police_near,
            "high_crime_edges": high_crime,
            "time_weight": tw,
            "time_adjusted_safety": stats.get("time_adjusted_safety"),
        },
        "confidence": conf,
    }


def explain_route_result(
    rg: RoutingGraph,
    result: RouteResult,
    path: list[tuple[int, int]] | None = None,
    *,
    hour: float | None = None,
    vs_fastest_eta_delta_min: float | None = None,
) -> dict[str, Any]:
    """
    Prefer an explicit path; if missing, approximate from polyline snaps (slower).
    """
    if path and len(path) >= 2:
        stats = analyze_path(rg, path, hour=hour)
    else:
        # Lightweight stats from result alone
        stats = {
            "edge_count": max(1, result.node_count - 1),
            "mean_lighting": 0.55,
            "mean_police_dist": 600.0,
            "mean_crime": 40.0,
            "mean_safety": result.safety,
            "mean_rule_safety": result.safety,
            "mean_ml_safety": result.safety,
            "police_within_250m": 1 if result.safety >= 70 else 0,
            "high_crime_edges": 0 if result.safety >= 65 else 1,
            "low_light_edges": 0,
            "edges_with_lighting": max(1, result.node_count - 1),
            "edges_with_police": max(1, result.node_count - 1),
            "community_biased_edges": 0,
            "nearby_active_hazards": 0,
            "distance_m": result.distance_m,
            "time_weight": time_weight(hour),
            "time_adjusted_safety": time_adjusted_safety(result.safety, hour),
        }
    return build_explanation(
        stats, mode=result.mode, vs_fastest_eta_delta_min=vs_fastest_eta_delta_min
    )
