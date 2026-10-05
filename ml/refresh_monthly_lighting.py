"""
Monthly night-lights refresh for road lighting scores.

Replaces the static 2022 annual VIIRS lighting with the latest monthly VIIRS
Day/Night Band composites (median of the last N months to fill monsoon cloud
gaps), then recomputes `lighting_score`, `brightness`, `viirs_radiance` and
`safety_score` in data/processed/road_safety_scores.csv. Police distance and
crime are untouched, so the slow road-network steps don't re-run.

Sources
  earthengine (default)  NOAA/VIIRS/DNB/MONTHLY_V1/VCMCFG via Google Earth Engine,
                         clipped to Mumbai server-side (a few KB download).
  file                   Any single-band radiance GeoTIFF you downloaded yourself
                         (e.g. NASA Black Marble VNP46A3), with --period YYYY-MM.

Earth Engine auth, first match wins
  EE_SERVICE_ACCOUNT_JSON  raw JSON or base64 key of a service account registered
                           for Earth Engine (CI / servers)
  `earthengine authenticate` user credentials on this machine (local)
  EE_PROJECT               Google Cloud project with the Earth Engine API enabled

Quality gates (keep last month's scores instead of writing bad data)
  * a road needs >= MIN_CLOUD_FREE_OBS cloud-free nights across the window,
    otherwise it keeps its previous lighting;
  * the run aborts if fewer than MIN_VALID_FRACTION of roads pass;
  * the run aborts if the median lighting moves more than MAX_MEDIAN_SHIFT
    (use --force after checking the data).

Normalization: radiance / reference, where reference tracks the Mumbai p99
with an exponential moving average so month-to-month noise doesn't rescale
every road.

  python -m ml.refresh_monthly_lighting                 # fetch latest + apply
  python -m ml.refresh_monthly_lighting --dry-run       # report only
  python -m ml.refresh_monthly_lighting --source file --file nl.tif --period 2026-08

Optional: set SAFEROUTE_API_URL and SAFEROUTE_ADMIN_TOKEN to have the running
routing API re-read the CSV immediately (POST /admin/reload).
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ml.predict import W_CRIME, W_LIGHT, W_POLICE, police_score  # noqa: E402

DATA = ROOT / "data"
PROCESSED = DATA / "processed"
VIIRS_DIR = DATA / "viirs"
SCORES_CSV = PROCESSED / "road_safety_scores.csv"
LIGHTING_META = PROCESSED / "lighting_meta.json"

# Same bbox as build_road_safety_scores.py (minx, miny, maxx, maxy)
MUMBAI_BBOX = (72.775, 18.892, 72.986, 19.270)
EE_COLLECTIONS = (
    "NOAA/VIIRS/DNB/MONTHLY_V1/VCMCFG",
    "NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG",
)
VIIRS_SCALE_M = 463.83

WINDOW_MONTHS = 3
MIN_CLOUD_FREE_OBS = 3
MIN_VALID_FRACTION = 0.85
MAX_MEDIAN_SHIFT = 0.20
REFERENCE_EMA = 0.2


def log(msg: str) -> None:
    print(msg, flush=True)


def github_output(**values: str) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as f:
        for key, value in values.items():
            f.write(f"{key}={value}\n")


def load_meta() -> dict:
    if not LIGHTING_META.exists():
        return {}
    with LIGHTING_META.open(encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------- Earth Engine
def init_earth_engine():
    import ee

    project = os.environ.get("EE_PROJECT") or None
    raw = os.environ.get("EE_SERVICE_ACCOUNT_JSON", "").strip()
    if raw:
        text = raw if raw.startswith("{") else base64.b64decode(raw).decode("utf-8")
        key = json.loads(text)
        creds = ee.ServiceAccountCredentials(key["client_email"], key_data=text)
        ee.Initialize(creds, project=project or key.get("project_id"))
    else:
        ee.Initialize(project=project)
    return ee


def fetch_earth_engine(window_months: int) -> tuple[Path, str, str, str]:
    """Download median radiance + summed cloud-free obs. Returns (tif, start, end, collection)."""
    import requests

    ee = init_earth_engine()
    region = ee.Geometry.Rectangle(list(MUMBAI_BBOX))
    last_error: Exception | None = None
    for collection_id in EE_COLLECTIONS:
        try:
            col = (
                ee.ImageCollection(collection_id)
                .filterBounds(region)
                .sort("system:time_start", False)
                .limit(window_months)
            )
            times = col.aggregate_array("system:time_start").getInfo()
            if not times:
                raise RuntimeError("collection returned no images")
            months = sorted(
                datetime.fromtimestamp(t / 1000, tz=timezone.utc).strftime("%Y-%m") for t in times
            )
            image = (
                col.select("avg_rad")
                .median()
                .rename("avg_rad")
                .addBands(col.select("cf_cvg").sum().rename("cf_cvg"))
                .clip(region)
                .toFloat()
            )
            url = image.getDownloadURL(
                {
                    "region": region,
                    "scale": VIIRS_SCALE_M,
                    "crs": "EPSG:4326",
                    "format": "GEO_TIFF",
                }
            )
            VIIRS_DIR.mkdir(parents=True, exist_ok=True)
            out = VIIRS_DIR / f"viirs_monthly_{months[0]}_{months[-1]}_mumbai.tif"
            resp = requests.get(url, timeout=180)
            resp.raise_for_status()
            out.write_bytes(resp.content)
            log(f"  downloaded {collection_id} {months[0]}..{months[-1]} -> {out.name}")
            return out, months[0], months[-1], collection_id
        except Exception as exc:  # noqa: BLE001
            log(f"  {collection_id} unavailable: {exc}")
            last_error = exc
    raise RuntimeError(f"No Earth Engine VIIRS collection usable: {last_error}")


def latest_earth_engine_month() -> str:
    ee = init_earth_engine()
    region = ee.Geometry.Rectangle(list(MUMBAI_BBOX))
    col = ee.ImageCollection(EE_COLLECTIONS[0]).filterBounds(region)
    latest = col.aggregate_max("system:time_start").getInfo()
    return datetime.fromtimestamp(latest / 1000, tz=timezone.utc).strftime("%Y-%m")


# ------------------------------------------------------------------ sampling
def sample_raster(path: Path, lons: np.ndarray, lats: np.ndarray) -> tuple[np.ndarray, np.ndarray | None]:
    """(radiance, cloud_free_obs or None) at each point; nodata/negative → nan."""
    import rasterio

    with rasterio.open(path) as src:
        coords = list(zip(lons.tolist(), lats.tolist()))
        samples = np.array([v for v in src.sample(coords)], dtype=float)
        nodata = src.nodata
        names = [d or "" for d in src.descriptions]
    if samples.ndim == 1:
        samples = samples[:, None]
    if nodata is not None:
        samples[samples == nodata] = np.nan
    rad_i = names.index("avg_rad") if "avg_rad" in names else 0
    radiance = samples[:, rad_i]
    radiance[radiance < 0] = np.nan
    obs = None
    if "cf_cvg" in names:
        obs = samples[:, names.index("cf_cvg")]
    elif samples.shape[1] >= 2:
        obs = samples[:, 1]
    return radiance, obs


def refresh(
    tif: Path,
    *,
    period_start: str,
    period_end: str,
    source_label: str,
    dry_run: bool,
    force: bool,
) -> dict:
    scores = pd.read_csv(SCORES_CSV, dtype={"road_id": str})
    prev_meta = load_meta()
    lons = scores["longitude"].astype(float).to_numpy()
    lats = scores["latitude"].astype(float).to_numpy()
    radiance, obs = sample_raster(tif, lons, lats)

    valid = np.isfinite(radiance)
    if obs is not None:
        valid &= np.nan_to_num(obs, nan=0.0) >= MIN_CLOUD_FREE_OBS
    valid_fraction = float(valid.mean())
    log(f"  roads with usable radiance: {valid.sum():,}/{len(valid):,} ({valid_fraction:.1%})")
    if valid_fraction < MIN_VALID_FRACTION:
        raise SystemExit(
            f"Only {valid_fraction:.1%} of roads have >= {MIN_CLOUD_FREE_OBS} cloud-free "
            f"observations (need {MIN_VALID_FRACTION:.0%}). Keeping previous lighting."
        )

    p99 = float(np.percentile(radiance[valid], 99))
    if p99 <= 0:
        raise SystemExit(f"Invalid radiance p99={p99}")
    prev_ref = prev_meta.get("reference_radiance")
    # First monthly run calibrates to the new product's scale.
    reference = p99 if not prev_ref else (1 - REFERENCE_EMA) * float(prev_ref) + REFERENCE_EMA * p99

    prev_lighting = scores["lighting_score"].astype(float).to_numpy()
    new_brightness = np.clip(100.0 * np.nan_to_num(radiance, nan=0.0) / reference, 0.0, 100.0)
    lighting = np.where(valid, new_brightness / 100.0, prev_lighting)
    brightness = np.where(valid, new_brightness, scores["brightness"].astype(float).to_numpy())
    viirs = np.where(valid, radiance, scores["viirs_radiance"].astype(float).to_numpy())

    shift = float(np.median(lighting) - np.median(prev_lighting))
    mean_abs_change = float(np.mean(np.abs(lighting - prev_lighting)))
    log(
        f"  p99={p99:.2f} reference={reference:.2f} | lighting median "
        f"{np.median(prev_lighting):.3f} -> {np.median(lighting):.3f} "
        f"(shift {shift:+.3f}, mean |change| {mean_abs_change:.3f})"
    )
    if abs(shift) > MAX_MEDIAN_SHIFT and not force:
        raise SystemExit(
            f"Median lighting shift {shift:+.3f} exceeds {MAX_MEDIAN_SHIFT}. "
            "Inspect the raster, then re-run with --force if it's genuine."
        )

    police = scores["police_dist"].astype(float).map(police_score)
    crime_component = 1.0 - scores["crime_score"].astype(float).clip(0, 100) / 100.0
    safety = 100.0 * (W_LIGHT * lighting + W_POLICE * police + W_CRIME * crime_component)

    summary = {
        "source": source_label,
        "period": f"{period_start}..{period_end}" if period_start != period_end else period_end,
        "period_start": period_start,
        "period_end": period_end,
        "window_months": WINDOW_MONTHS,
        "raster": tif.name,
        "reference_radiance": round(reference, 4),
        "p99_radiance": round(p99, 4),
        "roads_total": int(len(scores)),
        "roads_updated": int(valid.sum()),
        "roads_kept_previous": int((~valid).sum()),
        "valid_fraction": round(valid_fraction, 4),
        "median_lighting": round(float(np.median(lighting)), 4),
        "median_shift": round(shift, 4),
        "mean_abs_change": round(mean_abs_change, 4),
        "safety_median": round(float(np.median(safety)), 2),
        "updated_at_ms": int(time.time() * 1000),
        "previous": (
            {k: prev_meta.get(k) for k in ("source", "period", "updated_at_ms")} if prev_meta else None
        ),
    }
    if dry_run:
        log("  dry run: not writing files")
        return summary

    scores["lighting_score"] = np.round(lighting, 3)
    scores["brightness"] = np.round(brightness, 1)
    scores["viirs_radiance"] = np.round(viirs, 3)
    scores["safety_score"] = np.round(safety, 1)
    tmp = SCORES_CSV.with_suffix(".csv.tmp")
    scores.to_csv(tmp, index=False)
    tmp.replace(SCORES_CSV)
    with LIGHTING_META.open("w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    log(f"  wrote {SCORES_CSV.name} + {LIGHTING_META.name}")
    return summary


def notify_api() -> None:
    url = os.environ.get("SAFEROUTE_API_URL", "").rstrip("/")
    token = os.environ.get("SAFEROUTE_ADMIN_TOKEN", "")
    if not url or not token:
        return
    import requests

    try:
        resp = requests.post(
            f"{url}/admin/reload",
            headers={"X-Admin-Token": token},
            json={"sync_community": False, "reload_scores": True},
            timeout=120,
        )
        log(f"  API reload: HTTP {resp.status_code}")
    except Exception as exc:  # noqa: BLE001
        log(f"  API reload failed (server will pick it up on next deploy): {exc}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", choices=["earthengine", "file"], default="earthengine")
    parser.add_argument("--file", type=Path, help="GeoTIFF for --source file")
    parser.add_argument("--period", help="YYYY-MM label for --source file")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true", help="skip 'already up to date' and shift checks")
    args = parser.parse_args()

    meta = load_meta()
    if args.source == "file":
        if not args.file or not args.period:
            parser.error("--source file needs --file and --period")
        tif, start, end, label = args.file, args.period, args.period, f"file:{args.file.name}"
    else:
        latest = latest_earth_engine_month()
        log(f"Latest VIIRS monthly composite on Earth Engine: {latest}")
        if meta.get("period_end") == latest and not args.force:
            log(f"Already up to date ({latest}); nothing to do.")
            github_output(changed="false", period=latest)
            return
        tif, start, end, collection = fetch_earth_engine(WINDOW_MONTHS)
        label = f"VIIRS monthly {collection.rsplit('/', 1)[-1]} (median of {WINDOW_MONTHS} months)"

    summary = refresh(
        tif,
        period_start=start,
        period_end=end,
        source_label=label,
        dry_run=args.dry_run,
        force=args.force,
    )
    log(json.dumps(summary, indent=2))
    changed = not args.dry_run
    github_output(changed=str(changed).lower(), period=summary["period"])
    if changed:
        notify_api()


if __name__ == "__main__":
    main()
