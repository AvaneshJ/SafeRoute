"""
Live community reports from Firestore → the DataFrame shape community_intelligence expects.

Credentials, first match wins:
  FIREBASE_SERVICE_ACCOUNT_JSON   raw JSON or base64 of a service-account key (Render / Railway)
  GOOGLE_APPLICATION_CREDENTIALS  path to a key file (Application Default Credentials)
  ./<project>-firebase-adminsdk-*.json in the SafeRoute root (local dev; gitignored)

  python -m ml.firestore_reports      # prints a summary, no files written
"""
from __future__ import annotations

import base64
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
REPORTS_COLLECTION = "reports"
REPORT_AUTHORS_COLLECTION = "report_authors"
USERS_COLLECTION = "users"
# Matches expireOldReports in functions/src/index.ts.
LOOKBACK_DAYS = 180
DEFAULT_TRUST = 50.0
APP_NAME = "saferoute-routing"

REPORT_COLUMNS = [
    "report_id",
    "latitude",
    "longitude",
    "category",
    "severity",
    "status",
    "trust_score",
    "created_at_ms",
    "created_hour_local",
    "note",
]


def _credentials() -> Any | None:
    from firebase_admin import credentials

    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    if raw:
        text = raw if raw.startswith("{") else base64.b64decode(raw).decode("utf-8")
        return credentials.Certificate(json.loads(text))
    if os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        return credentials.ApplicationDefault()
    local = sorted(ROOT.glob("*-firebase-adminsdk-*.json"))
    if local:
        return credentials.Certificate(str(local[0]))
    return None


def firestore_configured() -> bool:
    try:
        import firebase_admin  # noqa: F401
    except ImportError:
        return False
    return bool(
        os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
        or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        or any(ROOT.glob("*-firebase-adminsdk-*.json"))
    )


def _client():
    import firebase_admin
    from firebase_admin import firestore

    try:
        app = firebase_admin.get_app(APP_NAME)
    except ValueError:
        cred = _credentials()
        if cred is None:
            raise RuntimeError("No Firebase service-account credentials configured")
        app = firebase_admin.initialize_app(cred, name=APP_NAME)
    return firestore.client(app)


def _local_tz():
    from .local_time import local_timezone

    return local_timezone()


def _trust_scores(db, user_ids: set[str]) -> dict[str, float]:
    if not user_ids:
        return {}
    refs = [db.collection(USERS_COLLECTION).document(uid) for uid in sorted(user_ids)]
    out: dict[str, float] = {}
    for start in range(0, len(refs), 200):
        for snap in db.get_all(refs[start : start + 200]):
            if not snap.exists:
                continue
            value = (snap.to_dict() or {}).get("trustScore")
            if isinstance(value, (int, float)):
                out[snap.id] = float(value)
    return out


def _report_authors(db, report_ids: list[str]) -> dict[str, str]:
    """reportId -> author uid from the private report_authors mirror."""
    refs = [db.collection(REPORT_AUTHORS_COLLECTION).document(rid) for rid in report_ids]
    out: dict[str, str] = {}
    for start in range(0, len(refs), 200):
        for snap in db.get_all(refs[start : start + 200]):
            if not snap.exists:
                continue
            author = (snap.to_dict() or {}).get("authorId")
            if isinstance(author, str) and author:
                out[snap.id] = author
    return out


def fetch_firestore_reports(lookback_days: int = LOOKBACK_DAYS) -> pd.DataFrame:
    """All non-rejected reports from the last `lookback_days`, with author trust attached."""
    from google.cloud.firestore_v1.base_query import FieldFilter

    db = _client()
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=lookback_days)
    tz = _local_tz()

    rows: list[dict[str, Any]] = []
    query = db.collection(REPORTS_COLLECTION).where(
        filter=FieldFilter("createdAt", ">=", cutoff)
    )
    for snap in query.stream():
        d = snap.to_dict() or {}
        status = str(d.get("status") or "pending").lower()
        if status in ("rejected", "expired", "spam"):
            continue
        try:
            lat = float(d["latitude"])
            lon = float(d["longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        created = d.get("createdAt")
        created_dt = created if isinstance(created, datetime) else now
        if created_dt.tzinfo is None:
            created_dt = created_dt.replace(tzinfo=timezone.utc)
        rows.append(
            {
                "report_id": snap.id,
                "latitude": lat,
                "longitude": lon,
                "category": str(d.get("category") or "other").lower(),
                "severity": float(d.get("severity") or 3),
                "status": status,
                "trust_score": DEFAULT_TRUST,
                "created_at_ms": int(created_dt.timestamp() * 1000),
                "created_hour_local": created_dt.astimezone(tz).hour,
                "note": "",
            }
        )

    authors = _report_authors(db, [row["report_id"] for row in rows])
    trust = _trust_scores(db, set(authors.values()))
    for row in rows:
        uid = authors.get(row["report_id"])
        if uid and uid in trust:
            row["trust_score"] = trust[uid]

    return pd.DataFrame(rows, columns=REPORT_COLUMNS)


def main() -> None:
    if not firestore_configured():
        raise SystemExit("Firestore credentials not configured (see module docstring).")
    df = fetch_firestore_reports()
    print(f"reports={len(df)}")
    if not df.empty:
        print(df.groupby(["category", "status"]).size().to_string())


if __name__ == "__main__":
    main()
