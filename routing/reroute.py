"""
Phase 6 — Live rerouting for Safe Walk.

Recalculates only the remaining path when a hazard appears ahead.
"""
from __future__ import annotations

from typing import Any

from .astar_router import RouteResult, astar_route, haversine_m, result_to_dict
from .dynamic_risk import TemporaryHazard, active_hazards, hazard_bias_near
from .explain_route import explain_route_result
from .graph_builder import RoutingGraph, snap_to_node


def hazard_ahead_of_route(
    position: tuple[float, float],
    destination: tuple[float, float],
    polyline: list[list[float]],
    *,
    look_ahead_m: float = 250.0,
) -> TemporaryHazard | None:
    """
    Find the nearest active hazard that sits ahead along the remaining walk
    (closer to dest than current, within look_ahead of the polyline).
    """
    plat, plon = position
    dlat, dlon = destination
    remaining_to_dest = haversine_m(plat, plon, dlat, dlon)

    best: TemporaryHazard | None = None
    best_d = 1e18
    for h in active_hazards():
        if not h.verified and h.weight() < 0.3:
            continue
        # Must be closer to destination than we are (roughly "ahead")
        h_to_dest = haversine_m(h.latitude, h.longitude, dlat, dlon)
        if h_to_dest >= remaining_to_dest + 40:
            continue
        # Distance from walker to hazard
        d_user = haversine_m(plat, plon, h.latitude, h.longitude)
        if d_user > look_ahead_m * 2:
            continue
        # Near the planned polyline?
        near_poly = False
        for pt in polyline[:: max(1, len(polyline) // 40)] or polyline:
            if haversine_m(h.latitude, h.longitude, pt[0], pt[1]) <= h.radius_m:
                near_poly = True
                break
        if not near_poly and d_user > look_ahead_m:
            continue
        if d_user < best_d:
            best_d = d_user
            best = h
    return best


def apply_hazard_penalties_to_graph(rg: RoutingGraph) -> int:
    """
    Recompute attrs.hazard_penalty from the current active hazard set.
    Kept separate from safety so repeated reroutes don't compound penalties.
    Returns number of edges penalised.
    """
    touched = 0
    hazards = active_hazards()
    for _u, _v, data in rg.graph.edges(data=True):
        attrs = data.get("attrs")
        if attrs is None:
            continue
        if not hazards:
            attrs.hazard_penalty = 0.0
            continue
        coords = getattr(attrs, "coords", None) or []
        if not coords:
            attrs.hazard_penalty = 0.0
            continue
        mid = coords[len(coords) // 2]
        lat, lon = float(mid[0]), float(mid[1])
        penalty = hazard_bias_near(lat, lon, hazards)
        attrs.hazard_penalty = penalty if penalty > 0.5 else 0.0
        if attrs.hazard_penalty:
            touched += 1
    return touched


def live_reroute(
    rg: RoutingGraph,
    position: tuple[float, float],
    destination: tuple[float, float],
    *,
    current_polyline: list[list[float]] | None = None,
    current_safety: float | None = None,
    mode: str = "safest",
) -> dict[str, Any]:
    """
    Recalculate remaining path with hazard-aware edge weights.
    """
    poly = current_polyline or []
    hazard = hazard_ahead_of_route(position, destination, poly)
    # Always refresh penalties from active hazard set
    touched = apply_hazard_penalties_to_graph(rg)

    new_route: RouteResult = astar_route(rg, position, destination, mode=mode)
    old_safety = float(current_safety) if current_safety is not None else new_route.safety
    delta = round(new_route.safety - old_safety)

    offer = False
    message = None
    detail = None
    if hazard is not None:
        d_m = round(
            haversine_m(position[0], position[1], hazard.latitude, hazard.longitude)
        )
        if delta >= 3 or touched > 0:
            offer = True
            message = "Safer route available"
            detail = (
                f"A recent community report was detected {d_m} m ahead."
                + (f" +{delta} safety" if delta > 0 else "")
            )
    elif delta >= 8:
        offer = True
        message = "Safer route available"
        detail = f"Conditions ahead changed. +{delta} safety"

    explanation = explain_route_result(rg, new_route, path=new_route.path, hour=new_route.hour)
    # Large snaps mean the walker is on a street the safety graph doesn't model.
    _, origin_snap_m = snap_to_node(rg, position[0], position[1])

    return {
        "origin_snap_m": round(origin_snap_m, 1),
        "offer": offer,
        "message": message,
        "detail": detail,
        "safety_delta": delta,
        "hazard": hazard.to_dict() if hazard else None,
        "edges_penalized": touched,
        "route": result_to_dict(new_route),
        "explanation": explanation,
    }
