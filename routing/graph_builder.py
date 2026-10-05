"""
Build and cache the Mumbai walkable road graph for SafeRoute A* routing.

Node = intersection (UTM-rounded)
Edge = road segment with length, safety, crime, police_dist, geometry polyline
"""
from __future__ import annotations

import math
import pickle
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import geopandas as gpd
import networkx as nx
import numpy as np
import pandas as pd
from sklearn.neighbors import BallTree

DATA = Path(__file__).resolve().parents[1] / "data"
PROCESSED = DATA / "processed"
ROADS_GPKG = DATA / "mumbai_roads.geojson.gpkg"
SCORES_CSV = PROCESSED / "road_safety_scores.csv"
WESTERN = DATA / "western-zone.gpkg"
GRAPH_CACHE = PROCESSED / "mumbai_routing_graph.pkl"

MUMBAI_BBOX = (72.775, 18.892, 72.986, 19.270)
METRIC_CRS = "EPSG:32643"
NODE_GRID_M = 2.0
SNAP_M = 300.0

ROAD_CLASSES = {
    "living_street",
    "pedestrian",
    "residential",
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
    "tertiary",
    "tertiary_link",
    "trunk",
    "trunk_link",
    "unclassified",
    "service",
    "footway",
    "path",
    "steps",
    "cycleway",
    "track",
}


@dataclass
class EdgeAttrs:
    road_id: str
    length_m: float
    safety: float
    crime_score: float
    police_dist: float
    lighting_score: float
    fclass: str
    # Lon/lat polyline along the edge (for API response)
    coords: list[tuple[float, float]] = field(default_factory=list)
    hospital_dist: float = 2000.0
    # Filled by Phase 4 ML apply; CSV safety preserved here
    safety_rule: float | None = None
    # Filled by ml.predict.apply_safety_to_graph (time-of-day + community bias)
    safety_day: float | None = None
    safety_night: float | None = None
    bias_day: float = 0.0
    bias_night: float = 0.0
    # Set per reroute from active temporary hazards; never baked into safety
    hazard_penalty: float = 0.0


@dataclass
class RoutingGraph:
    graph: nx.Graph
    node_xy: np.ndarray  # metres, aligned with node_keys
    node_keys: list[tuple[int, int]]
    node_latlng: dict[tuple[int, int], tuple[float, float]]
    meta: dict[str, Any]
    _snap_tree: BallTree | None = field(default=None, repr=False, compare=False)

    def snap_tree(self) -> BallTree:
        if self._snap_tree is None:
            self._snap_tree = BallTree(self.node_xy, metric="euclidean")
        return self._snap_tree


def _node_key(x: float, y: float) -> tuple[int, int]:
    return (int(round(x / NODE_GRID_M)), int(round(y / NODE_GRID_M)))


def _iter_lines(geom):
    if geom is None or geom.is_empty:
        return
    if geom.geom_type == "LineString":
        yield geom
    elif geom.geom_type == "MultiLineString":
        yield from geom.geoms
    elif geom.geom_type == "GeometryCollection":
        for part in geom.geoms:
            yield from _iter_lines(part)


def mumbai_mask() -> gpd.GeoDataFrame:
    admin = gpd.read_file(WESTERN, layer="gis_osm_adminareas_a_free")
    if admin.crs is None:
        admin = admin.set_crs("EPSG:4326")
    else:
        admin = admin.to_crs("EPSG:4326")
    mask = admin[admin["name"].isin(["Mumbai City District", "Mumbai Suburban District"])]
    if mask.empty:
        raise RuntimeError("Mumbai districts missing from western-zone.gpkg")
    return mask


def load_scored_roads() -> gpd.GeoDataFrame:
    if not ROADS_GPKG.exists():
        raise FileNotFoundError(ROADS_GPKG)
    if not SCORES_CSV.exists():
        raise FileNotFoundError(SCORES_CSV)

    print("Loading roads + safety scores…", flush=True)
    roads = gpd.read_file(ROADS_GPKG, bbox=MUMBAI_BBOX)
    if roads.crs is None:
        roads = roads.set_crs("EPSG:4326")
    else:
        roads = roads.to_crs("EPSG:4326")
    roads = gpd.clip(roads, mumbai_mask())
    roads = roads[roads["fclass"].isin(ROAD_CLASSES)].copy()
    roads["road_id"] = roads["osm_id"].astype(str)

    scores = pd.read_csv(SCORES_CSV, dtype={"road_id": str})
    keep = [
        "road_id",
        "safety_score",
        "crime_score",
        "police_dist",
        "lighting_score",
        "brightness",
        "hospital_dist",
    ]
    scores = scores[keep].drop_duplicates("road_id")
    merged = roads.merge(scores, on="road_id", how="inner")
    print(
        f"  scored roads: {len(merged):,} (roads {len(roads):,}, scores {len(scores):,})",
        flush=True,
    )
    if merged.empty:
        raise RuntimeError("No overlap between roads and safety scores")
    return merged


def build_routing_graph(roads: gpd.GeoDataFrame | None = None) -> RoutingGraph:
    t0 = time.time()
    if roads is None:
        roads = load_scored_roads()

    roads_m = roads.to_crs(METRIC_CRS)
    g = nx.Graph()
    node_latlng: dict[tuple[int, int], tuple[float, float]] = {}

    # Parallel WGS84 geometries for polyline export
    roads_ll = roads.to_crs("EPSG:4326")

    for idx, row in roads_m.iterrows():
        geom_m = row.geometry
        geom_ll = roads_ll.loc[idx].geometry
        safety = float(row.get("safety_score", 50) or 50)
        crime = float(row.get("crime_score", 50) or 50)
        police = float(row.get("police_dist", 2000) or 2000)
        lighting = float(row.get("lighting_score", 0.5) or 0.5)
        hospital = float(row.get("hospital_dist", 2000) or 2000)
        road_id = str(row["road_id"])
        fclass = str(row.get("fclass", ""))

        ll_parts = list(_iter_lines(geom_ll))
        m_parts = list(_iter_lines(geom_m))
        for part_i, (line_m, line_ll) in enumerate(zip(m_parts, ll_parts)):
            coords_m = list(line_m.coords)
            coords_ll = list(line_ll.coords)
            if len(coords_m) < 2:
                continue
            # One edge per consecutive vertex pair keeps intersections accurate
            for i in range(len(coords_m) - 1):
                x0, y0 = float(coords_m[i][0]), float(coords_m[i][1])
                x1, y1 = float(coords_m[i + 1][0]), float(coords_m[i + 1][1])
                a = _node_key(x0, y0)
                b = _node_key(x1, y1)
                if a == b:
                    continue
                length = math.hypot(x1 - x0, y1 - y0)
                if length <= 0:
                    continue
                lon0, lat0 = float(coords_ll[i][0]), float(coords_ll[i][1])
                lon1, lat1 = float(coords_ll[i + 1][0]), float(coords_ll[i + 1][1])
                node_latlng[a] = (lat0, lon0)
                node_latlng[b] = (lat1, lon1)
                polyline = [(lat0, lon0), (lat1, lon1)]
                attrs = EdgeAttrs(
                    road_id=f"{road_id}:{part_i}:{i}",
                    length_m=length,
                    safety=safety,
                    crime_score=crime,
                    police_dist=police,
                    lighting_score=lighting,
                    fclass=fclass,
                    coords=polyline,
                    hospital_dist=hospital,
                    safety_rule=safety,
                )
                if g.has_edge(a, b):
                    # Keep the safer / shorter of parallel edges
                    old = g[a][b]["attrs"]
                    if length < old.length_m or (
                        abs(length - old.length_m) < 0.5 and safety > old.safety
                    ):
                        g[a][b]["weight"] = length
                        g[a][b]["attrs"] = attrs
                else:
                    g.add_edge(a, b, weight=length, attrs=attrs)

    node_keys = list(g.nodes())
    node_xy = np.array(
        [[k[0] * NODE_GRID_M, k[1] * NODE_GRID_M] for k in node_keys], dtype=float
    )
    meta = {
        "nodes": g.number_of_nodes(),
        "edges": g.number_of_edges(),
        "built_s": round(time.time() - t0, 2),
        "crs": METRIC_CRS,
    }
    print(f"  graph nodes={meta['nodes']:,} edges={meta['edges']:,} ({meta['built_s']}s)", flush=True)
    return RoutingGraph(
        graph=g,
        node_xy=node_xy,
        node_keys=node_keys,
        node_latlng=node_latlng,
        meta=meta,
    )


def save_graph(rg: RoutingGraph, path: Path = GRAPH_CACHE) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as f:
        pickle.dump(rg, f, protocol=pickle.HIGHEST_PROTOCOL)
    print(f"  cached {path} ({path.stat().st_size / 1e6:.1f} MB)", flush=True)
    return path


def load_graph(path: Path = GRAPH_CACHE, rebuild: bool = False) -> RoutingGraph:
    if path.exists() and not rebuild:
        print(f"Loading cached graph {path}…", flush=True)
        with path.open("rb") as f:
            try:
                rg = pickle.load(f)
            except AttributeError:
                # Legacy pickle saved as __main__.RoutingGraph — rebuild once
                print("  stale pickle class path; rebuilding…", flush=True)
                rg = build_routing_graph()
                save_graph(rg, path)
                return rg
        print(
            f"  nodes={rg.meta.get('nodes'):,} edges={rg.meta.get('edges'):,}",
            flush=True,
        )
        return rg
    rg = build_routing_graph()
    save_graph(rg, path)
    return rg


def snap_to_node(
    rg: RoutingGraph, lat: float, lon: float, max_m: float = SNAP_M
) -> tuple[tuple[int, int] | None, float]:
    """Snap WGS84 point to nearest graph node. Returns (node_key, snap_m)."""
    # Project with approximate local UTM via geopandas one-point frame
    pt = gpd.GeoDataFrame(
        geometry=gpd.points_from_xy([lon], [lat]), crs="EPSG:4326"
    ).to_crs(METRIC_CRS)
    xy = np.array([[pt.geometry.iloc[0].x, pt.geometry.iloc[0].y]])
    dist, idx = rg.snap_tree().query(xy, k=1)
    d = float(dist[0][0])
    if d > max_m:
        return None, d
    return rg.node_keys[int(idx[0][0])], d


def main() -> None:
    # Rebuild via package import so pickle stores routing.graph_builder.RoutingGraph
    # (not __main__.RoutingGraph from `python -m`).
    rg = load_graph(rebuild=True)
    print("Done.", rg.meta)


if __name__ == "__main__":
    main()
