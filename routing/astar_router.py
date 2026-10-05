"""
A* router over the Mumbai walkable graph.

Heuristic: haversine metres to the goal. Admissible because
Cost = D × (1 + α × risk) ≥ D for α ≥ 0 and risk ∈ [0, 1].
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import networkx as nx

from .cost_function import RouteMode, edge_cost, eta_minutes, mode_alpha
from .graph_builder import RoutingGraph, snap_to_node


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


@dataclass
class RouteResult:
    mode: str
    distance_m: float
    eta_minutes: float
    safety: float
    cost: float
    polyline: list[list[float]]  # [[lat, lon], ...]
    node_count: int
    alpha: float
    path: list[tuple[int, int]] | None = None
    hour: float | None = None


def _path_metrics(
    rg: RoutingGraph, path: list[tuple[int, int]], alpha: float, hour: float | None = None
) -> tuple[float, float, float, list[list[float]]]:
    """Aggregate distance, length-weighted (time-adjusted) safety, total cost, polyline."""
    from .dynamic_risk import edge_safety_at, night_factor, time_adjusted_safety

    nf = night_factor(hour)
    if len(path) < 2:
        node = path[0] if path else None
        ll = rg.node_latlng.get(node, (0.0, 0.0)) if node else (0.0, 0.0)
        return 0.0, 50.0, 0.0, [[ll[0], ll[1]]]

    distance = 0.0
    safety_mass = 0.0
    cost = 0.0
    polyline: list[list[float]] = []

    for u, v in zip(path[:-1], path[1:]):
        data = rg.graph.get_edge_data(u, v) or {}
        attrs = data.get("attrs")
        if attrs is None:
            # Fallback length from node positions
            lat1, lon1 = rg.node_latlng[u]
            lat2, lon2 = rg.node_latlng[v]
            length = haversine_m(lat1, lon1, lat2, lon2)
            safety = 50.0
            coords = [(lat1, lon1), (lat2, lon2)]
        else:
            length = float(attrs.length_m)
            safety = edge_safety_at(attrs, nf)
            coords = list(attrs.coords)

        adj = time_adjusted_safety(safety, hour)
        distance += length
        safety_mass += adj * length
        cost += edge_cost(length, adj, alpha)

        if not polyline:
            polyline.append([coords[0][0], coords[0][1]])
        for lat, lon in coords[1:]:
            last = polyline[-1]
            if abs(last[0] - lat) > 1e-8 or abs(last[1] - lon) > 1e-8:
                polyline.append([lat, lon])

    mean_safety = safety_mass / distance if distance > 0 else 50.0
    return distance, mean_safety, cost, polyline


def astar_route(
    rg: RoutingGraph,
    origin: tuple[float, float],
    destination: tuple[float, float],
    mode: RouteMode | str = "balanced",
    hour: float | None = None,
) -> RouteResult:
    """
    origin / destination: (lat, lon)
    hour: optional local hour for time-aware risk (Phase 6)
    """
    from .dynamic_risk import (
        current_local_hour,
        edge_safety_at,
        night_factor,
        time_adjusted_safety,
    )

    alpha = mode_alpha(mode)
    o_lat, o_lon = float(origin[0]), float(origin[1])
    d_lat, d_lon = float(destination[0]), float(destination[1])
    if hour is None:
        hour = current_local_hour()
    nf = night_factor(hour)

    src, src_snap = snap_to_node(rg, o_lat, o_lon)
    dst, dst_snap = snap_to_node(rg, d_lat, d_lon)
    if src is None:
        raise ValueError(
            f"Origin not near walkable graph (nearest {src_snap:.0f} m; max snap 300 m)"
        )
    if dst is None:
        raise ValueError(
            f"Destination not near walkable graph (nearest {dst_snap:.0f} m; max snap 300 m)"
        )
    if src == dst:
        lat, lon = rg.node_latlng[src]
        return RouteResult(
            mode=str(mode),
            distance_m=0.0,
            eta_minutes=0.0,
            safety=100.0,
            cost=0.0,
            polyline=[[lat, lon]],
            node_count=1,
            alpha=alpha,
            path=[src],
            hour=hour,
        )

    goal_lat, goal_lon = rg.node_latlng[dst]

    def weight(u, v, data):
        attrs = data.get("attrs")
        if attrs is None:
            return float(data.get("weight", 1.0))
        adj = time_adjusted_safety(edge_safety_at(attrs, nf), hour)
        return edge_cost(attrs.length_m, adj, alpha)

    def heuristic(u, v=None):
        n = u
        lat, lon = rg.node_latlng[n]
        return haversine_m(lat, lon, goal_lat, goal_lon)

    try:
        path = nx.astar_path(
            rg.graph, src, dst, heuristic=heuristic, weight=weight
        )
    except nx.NetworkXNoPath as exc:
        raise ValueError("No walkable path between origin and destination") from exc

    distance, safety, cost, polyline = _path_metrics(rg, path, alpha, hour=hour)
    if polyline:
        if abs(polyline[0][0] - o_lat) > 1e-6 or abs(polyline[0][1] - o_lon) > 1e-6:
            polyline = [[o_lat, o_lon], *polyline]
        if abs(polyline[-1][0] - d_lat) > 1e-6 or abs(polyline[-1][1] - d_lon) > 1e-6:
            polyline = [*polyline, [d_lat, d_lon]]

    return RouteResult(
        mode=str(mode),
        distance_m=round(distance, 1),
        eta_minutes=round(eta_minutes(distance), 1),
        safety=round(safety, 1),
        cost=round(cost, 1),
        polyline=polyline,
        node_count=len(path),
        alpha=alpha,
        path=path,
        hour=hour,
    )


def route_all_modes(
    rg: RoutingGraph,
    origin: tuple[float, float],
    destination: tuple[float, float],
    hour: float | None = None,
) -> list[RouteResult]:
    modes: list[RouteMode] = ["safest", "balanced", "fastest"]
    return [astar_route(rg, origin, destination, mode=m, hour=hour) for m in modes]


def result_to_dict(r: RouteResult) -> dict[str, Any]:
    return {
        "type": r.mode,
        "distance": round(r.distance_m),
        "eta": round(r.eta_minutes),
        "safety": round(r.safety),
        "alpha": r.alpha,
        "cost": r.cost,
        "polyline": r.polyline,
        "node_count": r.node_count,
        "hour": r.hour,
    }
