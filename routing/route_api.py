"""
FastAPI backend for SafeRoute Phase 3–6.

  POST /route/safe
  GET  /route/explain/{id}
  GET  /route/confidence/{id}
  POST /report/hazard
  POST /route/reroute
  GET  /health
  GET  /ml/metrics
  GET  /community/stats
  POST /admin/reload          (X-Admin-Token: $SAFEROUTE_ADMIN_TOKEN)

Background: every $COMMUNITY_SYNC_MINUTES (default 15, 0 = off) pull Firestore
reports → rebuild community bias → re-apply edge safety in place.

Run from SafeRoute/:
  python -m uvicorn routing.route_api:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import asyncio
import hmac
import json
import os
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .astar_router import result_to_dict, route_all_modes
from .dynamic_risk import (
    active_hazards,
    add_hazard,
    current_local_hour,
    load_hazards,
    night_factor,
    time_weight,
)
from .explain_route import explain_route_result
from .graph_builder import RoutingGraph, load_graph
from .reroute import live_reroute

ModeName = Literal["safest", "balanced", "fastest", "all"]
SafetyEngineName = Literal["xgboost", "rule", "compare"]

_graph: RoutingGraph | None = None
_weights_engine: Literal["xgboost", "rule"] | None = None
_ml_meta: dict[str, Any] = {"ml_loaded": False, "safety_engine": "rule"}
# Phase 6 — in-memory route cards for explain / confidence lookups
_ROUTE_CACHE: dict[str, dict[str, Any]] = {}

ROOT = Path(__file__).resolve().parents[1]
ML_METRICS = ROOT / "ml" / "metrics.json"
PROCESSED = ROOT / "data" / "processed"
SCORES_CSV = PROCESSED / "road_safety_scores.csv"
BIAS_JSON = PROCESSED / "community_bias.json"
LIGHTING_META = PROCESSED / "lighting_meta.json"

COMMUNITY_SYNC_MINUTES = float(os.environ.get("COMMUNITY_SYNC_MINUTES", "15") or 0)
ADMIN_TOKEN = os.environ.get("SAFEROUTE_ADMIN_TOKEN", "").strip()

_reload_lock = threading.Lock()
_data_status: dict[str, Any] = {
    "last_reload_at_ms": None,
    "last_reload_reason": None,
    "last_sync": None,
    "last_sync_error": None,
}
_applied_mtimes: dict[str, float] = {}


def get_graph() -> RoutingGraph:
    global _graph
    if _graph is None:
        _graph = load_graph(rebuild=False)
    return _graph


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _set_edge_weights(
    engine: Literal["xgboost", "rule"], force: bool = False
) -> dict[str, Any]:
    global _weights_engine, _ml_meta
    from ml.predict import apply_safety_to_graph

    if not force and _weights_engine == engine and _ml_meta.get("edges_updated"):
        return _ml_meta

    g = get_graph()
    meta = apply_safety_to_graph(g, engine=engine)
    _weights_engine = engine if meta.get("ml_loaded") or engine == "rule" else "rule"
    if engine == "xgboost" and not meta.get("ml_loaded"):
        _weights_engine = "rule"
    _ml_meta = meta
    _applied_mtimes["scores"] = _mtime(SCORES_CSV)
    _applied_mtimes["bias"] = _mtime(BIAS_JSON)
    return meta


def reload_safety_data(
    *, sync_community: bool, reload_scores: bool, reason: str
) -> dict[str, Any]:
    """
    Optionally pull fresh Firestore reports, then re-read CSV / bias from disk
    and re-apply edge safety in place. Safe to call from a worker thread.
    """
    from ml.community_intelligence import sync_community_bias
    from ml.predict import reload_data

    with _reload_lock:
        t0 = time.time()
        sync_meta: dict[str, Any] | None = None
        if sync_community:
            try:
                sync_meta = sync_community_bias("auto")
                _data_status["last_sync"] = sync_meta
                _data_status["last_sync_error"] = None
            except Exception as exc:  # noqa: BLE001
                first_line = (str(exc).strip().splitlines() or [""])[0][:300]
                _data_status["last_sync_error"] = f"{type(exc).__name__}: {first_line}"
                print(f"  community sync failed: {_data_status['last_sync_error']}", flush=True)

        reload_data(scores=reload_scores, bias=True)
        engine = _weights_engine or "xgboost"
        meta = _set_edge_weights(engine, force=True)
        _data_status["last_reload_at_ms"] = int(time.time() * 1000)
        _data_status["last_reload_reason"] = reason
        return {
            "ok": True,
            "reason": reason,
            "community_sync": sync_meta,
            "community_sync_error": _data_status["last_sync_error"],
            "safety": meta,
            "took_s": round(time.time() - t0, 2),
        }


def _files_changed_since_apply() -> bool:
    return (
        _mtime(SCORES_CSV) != _applied_mtimes.get("scores")
        or _mtime(BIAS_JSON) != _applied_mtimes.get("bias")
    )


async def _community_sync_loop() -> None:
    from ml.firestore_reports import firestore_configured

    interval_s = max(60.0, COMMUNITY_SYNC_MINUTES * 60.0)
    await asyncio.sleep(5)
    while True:
        try:
            sync = firestore_configured()
            if sync or _files_changed_since_apply():
                await asyncio.to_thread(
                    reload_safety_data,
                    sync_community=sync,
                    reload_scores=_mtime(SCORES_CSV) != _applied_mtimes.get("scores"),
                    reason="scheduled_sync" if sync else "data_files_changed",
                )
        except Exception as exc:  # noqa: BLE001
            print(f"  background sync error: {exc}", flush=True)
        await asyncio.sleep(interval_s)


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        with path.open(encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def data_freshness() -> dict[str, Any]:
    bias = _read_json(BIAS_JSON) or {}
    lighting = _read_json(LIGHTING_META) or {}
    return {
        "community": {
            "source": bias.get("source"),
            "generated_at_ms": bias.get("generated_at_ms"),
            "reports_used": bias.get("reports_used"),
            "reports_by_category": bias.get("reports_by_category"),
            "roads_affected": bias.get("roads_affected"),
            "sync_interval_min": COMMUNITY_SYNC_MINUTES or None,
            "last_sync_error": _data_status["last_sync_error"],
        },
        "lighting": {
            "source": lighting.get("source", "VIIRS annual VNL V2 2022"),
            "period": lighting.get("period", "2022"),
            "updated_at_ms": lighting.get("updated_at_ms"),
        },
        "crime": {"source": "Praja Foundation 2023 report (2022 data)", "grain": "region"},
        "last_reload_at_ms": _data_status["last_reload_at_ms"],
        "last_reload_reason": _data_status["last_reload_reason"],
    }


def _enrich_and_cache(results: list, g: RoutingGraph) -> list[dict[str, Any]]:
    fastest_eta = min((r.eta_minutes for r in results), default=0.0)
    cards: list[dict[str, Any]] = []
    for r in results:
        route_id = str(uuid.uuid4())[:12]
        delta = r.eta_minutes - fastest_eta
        explanation = explain_route_result(
            g,
            r,
            path=r.path,
            hour=r.hour,
            vs_fastest_eta_delta_min=delta if r.mode != "fastest" else None,
        )
        card = result_to_dict(r)
        card["id"] = route_id
        card["explanation"] = explanation
        card["confidence"] = explanation.get("confidence", {}).get("confidence")
        card["confidence_detail"] = explanation.get("confidence")
        card["reasons"] = explanation.get("reasons", [])
        card["time_weight"] = time_weight(r.hour)
        _ROUTE_CACHE[route_id] = {
            "card": card,
            "path": r.path,
            "result": r,
            "explanation": explanation,
        }
        # Keep cache bounded
        if len(_ROUTE_CACHE) > 200:
            for old in list(_ROUTE_CACHE.keys())[:50]:
                _ROUTE_CACHE.pop(old, None)
        cards.append(card)
    return cards


@asynccontextmanager
async def lifespan(app: FastAPI):
    get_graph()
    load_hazards()
    try:
        _set_edge_weights("xgboost")
    except Exception as exc:  # noqa: BLE001
        print(f"ML warmup skipped: {exc}", flush=True)
        _set_edge_weights("rule")
    sync_task = (
        asyncio.create_task(_community_sync_loop()) if COMMUNITY_SYNC_MINUTES > 0 else None
    )
    try:
        yield
    finally:
        if sync_task is not None:
            sync_task.cancel()


app = FastAPI(
    title="SafeRoute Routing API",
    version="6.0.0",
    description=(
        "A* safety routes + XGBoost + community bias + "
        "explainable AI, confidence, time-aware risk, live reroute."
    ),
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class RouteSafeRequest(BaseModel):
    origin: list[float] = Field(..., min_length=2, max_length=2)
    destination: list[float] = Field(..., min_length=2, max_length=2)
    mode: ModeName = "balanced"
    safety_engine: SafetyEngineName = "xgboost"
    hour: float | None = Field(
        default=None, description="Local hour 0–24 for time-aware risk"
    )


class RouteCard(BaseModel):
    id: str | None = None
    type: str
    distance: int
    eta: int
    safety: int
    alpha: float
    cost: float
    polyline: list[list[float]]
    node_count: int
    confidence: int | None = None
    reasons: list[dict[str, str]] | None = None
    time_weight: float | None = None
    explanation: dict[str, Any] | None = None
    confidence_detail: dict[str, Any] | None = None
    hour: float | None = None


class RouteSafeResponse(BaseModel):
    routes: list[RouteCard]
    selected: str
    safety_engine: str
    ml_loaded: bool
    rule_routes: list[RouteCard] | None = None
    time_weight: float | None = None


class HazardRequest(BaseModel):
    latitude: float
    longitude: float
    category: str = "harassment"
    severity: int = Field(default=4, ge=1, le=5)
    note: str = ""
    verified: bool = True
    radius_m: float = 180.0


class RerouteRequest(BaseModel):
    position: list[float] = Field(..., min_length=2, max_length=2)
    destination: list[float] = Field(..., min_length=2, max_length=2)
    mode: ModeName = "safest"
    current_polyline: list[list[float]] | None = None
    current_safety: float | None = None


@app.get("/health")
def health() -> dict[str, Any]:
    g = get_graph()
    return {
        "ok": True,
        "nodes": g.meta.get("nodes"),
        "edges": g.meta.get("edges"),
        "safety_engine": _weights_engine or _ml_meta.get("safety_engine"),
        "ml_loaded": bool(_ml_meta.get("ml_loaded")),
        "community_bias_roads": _ml_meta.get("community_bias_roads", 0),
        "active_hazards": len(active_hazards()),
        "cached_routes": len(_ROUTE_CACHE),
        "local_hour": round(current_local_hour(), 2),
        "time_weight": time_weight(),
        "night_factor": round(night_factor(), 2),
        "data": data_freshness(),
        "version": "6.1.0",
    }


class AdminReloadRequest(BaseModel):
    sync_community: bool = True
    reload_scores: bool = True


@app.post("/admin/reload")
async def admin_reload(
    body: AdminReloadRequest | None = None,
    x_admin_token: str | None = Header(default=None),
) -> dict[str, Any]:
    """Pull Firestore reports and/or re-read safety CSVs without restarting."""
    if not ADMIN_TOKEN:
        raise HTTPException(403, "Set SAFEROUTE_ADMIN_TOKEN on the server to enable reloads")
    if not x_admin_token or not hmac.compare_digest(x_admin_token, ADMIN_TOKEN):
        raise HTTPException(401, "Invalid admin token")
    opts = body or AdminReloadRequest()
    return await asyncio.to_thread(
        reload_safety_data,
        sync_community=opts.sync_community,
        reload_scores=opts.reload_scores,
        reason="admin",
    )


@app.get("/community/stats")
def community_stats() -> dict[str, Any]:
    bias_path = (
        Path(__file__).resolve().parents[1]
        / "data"
        / "processed"
        / "community_bias.json"
    )
    if not bias_path.exists():
        return {"ok": False, "message": "Run python -m ml.community_intelligence"}
    with bias_path.open(encoding="utf-8") as f:
        data = json.load(f)
    return {
        "ok": True,
        "source": data.get("source"),
        "generated_at_ms": data.get("generated_at_ms"),
        "reports_used": data.get("reports_used"),
        "reports_by_category": data.get("reports_by_category"),
        "roads_affected": data.get("roads_affected"),
        "max_bias": data.get("max_bias"),
        "half_life_days": data.get("half_life_days"),
        "top_biased_roads": list((data.get("bias") or {}).items())[:10],
        "active_hazards": [h.to_dict() for h in active_hazards()],
    }


@app.get("/ml/metrics")
def ml_metrics() -> dict[str, Any]:
    if not ML_METRICS.exists():
        raise HTTPException(404, "metrics.json not found — run python -m ml.train_xgboost")
    with ML_METRICS.open(encoding="utf-8") as f:
        return json.load(f)


@app.post("/route/safe", response_model=RouteSafeResponse)
def route_safe(body: RouteSafeRequest) -> RouteSafeResponse:
    origin = (float(body.origin[0]), float(body.origin[1]))
    destination = (float(body.destination[0]), float(body.destination[1]))
    if not (-90 <= origin[0] <= 90 and -180 <= origin[1] <= 180):
        raise HTTPException(400, "Invalid origin coordinates")
    if not (-90 <= destination[0] <= 90 and -180 <= destination[1] <= 180):
        raise HTTPException(400, "Invalid destination coordinates")

    hour = body.hour
    if hour is None:
        hour = current_local_hour()

    engine = body.safety_engine
    primary: Literal["xgboost", "rule"] = "rule" if engine == "rule" else "xgboost"
    meta = _set_edge_weights(primary)

    g = get_graph()
    try:
        results = route_all_modes(g, origin, destination, hour=hour)
        selected = "balanced" if body.mode == "all" else body.mode
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    cards = [RouteCard(**c) for c in _enrich_and_cache(results, g)]
    rule_cards: list[RouteCard] | None = None

    if engine == "compare":
        _set_edge_weights("rule")
        try:
            rule_results = route_all_modes(g, origin, destination, hour=hour)
            rule_cards = [RouteCard(**c) for c in _enrich_and_cache(rule_results, g)]
        except ValueError:
            rule_cards = None
        meta = _set_edge_weights("xgboost")

    return RouteSafeResponse(
        routes=cards,
        selected=selected,
        safety_engine=engine,
        ml_loaded=bool(meta.get("ml_loaded")),
        rule_routes=rule_cards,
        time_weight=time_weight(hour),
    )


@app.get("/route/explain/{route_id}")
def route_explain(route_id: str) -> dict[str, Any]:
    entry = _ROUTE_CACHE.get(route_id)
    if not entry:
        raise HTTPException(404, "Route id not found or expired — request /route/safe again")
    return {
        "id": route_id,
        "type": entry["card"].get("type"),
        **entry["explanation"],
    }


@app.get("/route/confidence/{route_id}")
def route_confidence_ep(route_id: str) -> dict[str, Any]:
    entry = _ROUTE_CACHE.get(route_id)
    if not entry:
        raise HTTPException(404, "Route id not found or expired")
    conf = entry["explanation"].get("confidence") or {}
    return {"id": route_id, "safety": entry["card"].get("safety"), **conf}


@app.post("/report/hazard")
def report_hazard(body: HazardRequest) -> dict[str, Any]:
    """Create a temporary decaying community hazard (Phase 6)."""
    h = add_hazard(
        latitude=body.latitude,
        longitude=body.longitude,
        category=body.category,
        severity=body.severity,
        note=body.note,
        verified=body.verified,
        radius_m=body.radius_m,
    )
    return {"ok": True, "hazard": h.to_dict()}


@app.post("/route/reroute")
def route_reroute(body: RerouteRequest) -> dict[str, Any]:
    """Live Safe Walk recalculation of the remaining path."""
    position = (float(body.position[0]), float(body.position[1]))
    destination = (float(body.destination[0]), float(body.destination[1]))
    mode = "balanced" if body.mode == "all" else body.mode

    _set_edge_weights("xgboost")
    g = get_graph()
    try:
        payload = live_reroute(
            g,
            position,
            destination,
            current_polyline=body.current_polyline,
            current_safety=body.current_safety,
            mode=mode,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    # Cache the new route for explain/confidence
    route = payload.get("route") or {}
    route_id = str(uuid.uuid4())[:12]
    route["id"] = route_id
    expl = payload.get("explanation") or {}
    route["explanation"] = expl
    route["confidence"] = expl.get("confidence", {}).get("confidence")
    route["reasons"] = expl.get("reasons", [])
    _ROUTE_CACHE[route_id] = {
        "card": route,
        "path": None,
        "result": None,
        "explanation": expl,
    }
    payload["route"] = route
    return payload


def main() -> None:
    import uvicorn

    uvicorn.run("routing.route_api:app", host="0.0.0.0", port=8000, reload=False)


if __name__ == "__main__":
    main()
