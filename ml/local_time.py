"""Mumbai wall-clock time for scoring, independent of the server's timezone (Render/Railway run UTC)."""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone, tzinfo

DEFAULT_TZ = "Asia/Kolkata"


def local_timezone() -> tzinfo:
    name = os.environ.get("SAFEROUTE_TZ", DEFAULT_TZ)
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(name)
    except Exception:  # noqa: BLE001 — no tzdata on the host
        return timezone(timedelta(hours=5, minutes=30), "IST")


def local_hour_now() -> float:
    now = datetime.now(local_timezone())
    return now.hour + now.minute / 60.0
