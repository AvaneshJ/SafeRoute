"""
XGBoost safety prediction + rule-engine fallback for SafeRoute routing.

Safety engines
  xgboost  — primary ML prediction (edge weights)
  rule     — deterministic CSV / 0.35L + 0.35P + 0.30(1−C)
  compare  — apply XGBoost for routing; rule scores kept for debug
"""
from __future__ import annotations

import pickle
import time
from pathlib import Path
from typing import Any, Literal

import numpy as np
import pandas as pd

ML_DIR = Path(__file__).resolve().parent
MODEL_PATH = ML_DIR / "model.pkl"
SCORES_CSV = ML_DIR.parent / "data" / "processed" / "road_safety_scores.csv"

FEATURE_COLS = [
    "lighting_score",
    "police_dist",
    "crime_score",
    "hospital_dist",
]
TARGET_COL = "safety_score"

SafetyEngine = Literal["xgboost", "rule", "compare"]

# Same weights as data/build_road_safety_scores.py
W_LIGHT = 0.35
W_POLICE = 0.35
W_CRIME = 0.30

_model_bundle: dict[str, Any] | None = None
_feature_table: pd.DataFrame | None = None
_ml_by_road: dict[str, float] | None = None
_rule_by_road: dict[str, float] | None = None
_community_bias: tuple[dict[str, float], dict[str, float]] | None = None


def load_community_bias_cached(force: bool = False) -> tuple[dict[str, float], dict[str, float]]:
    """(day, night) community bias maps."""
    global _community_bias
    if _community_bias is not None and not force:
        return _community_bias
    try:
        from .community_intelligence import load_community_bias_layers

        _community_bias = load_community_bias_layers()
    except Exception as exc:  # noqa: BLE001
        print(f"  community bias unavailable ({exc})", flush=True)
        _community_bias = ({}, {})
    return _community_bias


def reload_data(*, scores: bool = True, bias: bool = True) -> None:
    """Drop cached CSV / predictions / bias so the next apply re-reads disk."""
    global _feature_table, _ml_by_road, _rule_by_road, _community_bias
    if scores:
        _feature_table = None
        _ml_by_road = None
        _rule_by_road = None
    if bias:
        _community_bias = None


def police_score(dist_m: float) -> float:
    """Piecewise police proximity score used by the rule engine."""
    if dist_m is None or (isinstance(dist_m, float) and np.isnan(dist_m)):
        return 0.2
    d = float(dist_m)
    if d <= 200:
        return 1.0
    if d <= 500:
        return 0.8
    if d <= 800:
        return 0.6
    if d <= 1200:
        return 0.4
    return 0.2


def rule_safety_score(
    lighting_score: float,
    police_dist: float,
    crime_score: float,
    hospital_dist: float | None = None,  # unused by rule; API symmetry
) -> float:
    """
    Deterministic MVP equation:
      safety = 100 × (0.35·L + 0.35·P + 0.30·(1 − C/100))
    """
    L = max(0.0, min(1.0, float(lighting_score)))
    P = police_score(float(police_dist))
    C = max(0.0, min(100.0, float(crime_score)))
    score = 100.0 * (W_LIGHT * L + W_POLICE * P + W_CRIME * (1.0 - C / 100.0))
    return float(max(0.0, min(100.0, score)))


def load_model(path: Path = MODEL_PATH) -> dict[str, Any]:
    global _model_bundle
    if _model_bundle is not None and path == MODEL_PATH:
        return _model_bundle
    if not path.exists():
        raise FileNotFoundError(f"XGBoost model not found: {path}")
    with path.open("rb") as f:
        bundle = pickle.load(f)
    if path == MODEL_PATH:
        _model_bundle = bundle
    return bundle


def model_available(path: Path = MODEL_PATH) -> bool:
    try:
        load_model(path)
        return True
    except Exception:
        return False


def load_feature_table(csv_path: Path = SCORES_CSV) -> pd.DataFrame:
    global _feature_table
    if _feature_table is not None:
        return _feature_table
    df = pd.read_csv(csv_path, dtype={"road_id": str})
    keep = ["road_id", *FEATURE_COLS, TARGET_COL]
    missing = [c for c in keep if c not in df.columns]
    if missing:
        raise ValueError(f"Feature CSV missing: {missing}")
    table = df[keep].drop_duplicates("road_id").set_index("road_id")
    _feature_table = table
    return table


def predict_safety(
    lighting_score: float,
    police_dist: float,
    crime_score: float,
    hospital_dist: float = 2000.0,
    model_bundle: dict[str, Any] | None = None,
) -> float:
    """Single-road XGBoost prediction (clamped 0–100)."""
    bundle = model_bundle or load_model()
    model = bundle["model"]
    features = list(bundle.get("features") or FEATURE_COLS)
    row = {
        "lighting_score": float(lighting_score),
        "police_dist": float(police_dist),
        "crime_score": float(crime_score),
        "hospital_dist": float(hospital_dist),
    }
    X = np.array([[row[f] for f in features]], dtype=float)
    pred = float(model.predict(X)[0])
    return float(max(0.0, min(100.0, pred)))


def predict_batch(
    X: np.ndarray,
    model_bundle: dict[str, Any] | None = None,
) -> np.ndarray:
    bundle = model_bundle or load_model()
    pred = bundle["model"].predict(X)
    return np.clip(np.asarray(pred, dtype=float), 0.0, 100.0)


def _road_score_maps(
    model_path: Path = MODEL_PATH,
) -> tuple[dict[str, float], dict[str, float], bool]:
    """Return (ml_by_road, rule_by_road, ml_ok). Cached after first call."""
    global _ml_by_road, _rule_by_road

    table = load_feature_table()
    if _rule_by_road is None:
        _rule_by_road = {
            str(rid): float(score)
            for rid, score in table[TARGET_COL].items()
        }

    if _ml_by_road is not None:
        return _ml_by_road, _rule_by_road, True

    try:
        bundle = load_model(model_path)
        feats = list(bundle.get("features") or FEATURE_COLS)
        X = table[feats].astype(float).values
        preds = predict_batch(X, bundle)
        _ml_by_road = {
            str(rid): float(p) for rid, p in zip(table.index.astype(str), preds)
        }
        return _ml_by_road, _rule_by_road, True
    except Exception as exc:  # noqa: BLE001
        print(f"  XGBoost unavailable ({exc}); using rule engine", flush=True)
        _ml_by_road = dict(_rule_by_road)
        return _ml_by_road, _rule_by_road, False


def _base_road_id(edge_road_id: str) -> str:
    # Graph stores "{osm_id}:{part}:{i}"
    return str(edge_road_id).split(":", 1)[0]


def _time_shift_maps(table: pd.DataFrame) -> tuple[dict[str, float], dict[str, float]]:
    """
    Per road: how much the rule score moves when re-weighted for day / night,
    relative to the static 0.35/0.35/0.30 score the model was trained on.
    """
    from routing.dynamic_risk import DAY_WEIGHTS, NIGHT_WEIGHTS, STATIC_WEIGHTS

    L = table["lighting_score"].astype(float).clip(0.0, 1.0)
    P = table["police_dist"].astype(float).map(police_score)
    C = 1.0 - table["crime_score"].astype(float).clip(0.0, 100.0) / 100.0

    def score(w: tuple[float, float, float]) -> pd.Series:
        return 100.0 * (w[0] * L + w[1] * P + w[2] * C)

    static = score(STATIC_WEIGHTS)
    ids = table.index.astype(str)
    # Zero-mean: re-weighting only re-ranks roads; the overall after-dark risk
    # increase comes from dynamic_risk.time_weight.
    day_shift = score(DAY_WEIGHTS) - static
    night_shift = score(NIGHT_WEIGHTS) - static
    day = dict(zip(ids, (day_shift - day_shift.mean()).round(2)))
    night = dict(zip(ids, (night_shift - night_shift.mean()).round(2)))
    return day, night


def apply_safety_to_graph(
    rg: Any,
    engine: SafetyEngine = "xgboost",
    model_path: Path = MODEL_PATH,
) -> dict[str, Any]:
    """
    Set per-edge safety used by A*:

      safety_day / safety_night = base + time-of-day shift − community bias
      safety                    = value at the current Mumbai hour (legacy readers)

    `base` is the XGBoost prediction (or rule score if the model can't load).
    Always preserves attrs.safety_rule (CSV rule-engine score).
    """
    from routing.dynamic_risk import edge_safety_at, night_factor

    t0 = time.time()
    used: SafetyEngine = engine if engine != "compare" else "xgboost"

    ml_by_road, rule_by_road, ml_ok = _road_score_maps(model_path)
    if used == "xgboost" and not ml_ok:
        used = "rule"

    table = load_feature_table()
    shift_day, shift_night = _time_shift_maps(table)
    lighting = table["lighting_score"].astype(float).to_dict()
    score_map = rule_by_road if used == "rule" else ml_by_road
    bias_day_map, bias_night_map = load_community_bias_cached()
    nf_now = night_factor()
    biased_roads = 0

    updated = 0
    for _u, _v, data in rg.graph.edges(data=True):
        attrs = data.get("attrs")
        if attrs is None:
            continue
        base_id = _base_road_id(attrs.road_id)
        rule = rule_by_road.get(base_id)
        if rule is None:
            rule = float(getattr(attrs, "safety_rule", None) or attrs.safety)
        attrs.safety_rule = rule
        base = float(score_map.get(base_id, rule))
        b_day = float(bias_day_map.get(base_id, 0.0))
        b_night = float(bias_night_map.get(base_id, 0.0))
        if b_day > 0 or b_night > 0:
            biased_roads += 1
        attrs.bias_day = b_day
        attrs.bias_night = b_night
        attrs.safety_day = max(0.0, min(100.0, base + shift_day.get(base_id, 0.0) - b_day))
        attrs.safety_night = max(0.0, min(100.0, base + shift_night.get(base_id, 0.0) - b_night))
        if base_id in lighting:
            attrs.lighting_score = float(lighting[base_id])
        attrs.safety = edge_safety_at(attrs, nf_now)
        updated += 1

    meta = {
        "safety_engine": used,
        "requested_engine": engine,
        "ml_loaded": ml_ok,
        "edges_updated": updated,
        "community_bias_roads": biased_roads,
        "community_bias_loaded": bool(bias_day_map or bias_night_map),
        "apply_s": round(time.time() - t0, 2),
    }
    rg.meta.update(meta)
    print(
        f"  safety engine={used} ml_loaded={ml_ok} "
        f"community_bias_roads={biased_roads} "
        f"edges={updated:,} ({meta['apply_s']}s)",
        flush=True,
    )
    return meta
