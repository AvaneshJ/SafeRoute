"""
One-off: move `authorIdPrivate` off public report docs into the private
`report_authors/{reportId}` mirror. Safe to re-run.

  python -m ml.migrate_report_authors            # dry run
  python -m ml.migrate_report_authors --apply
"""
from __future__ import annotations

import sys

from google.cloud.firestore_v1 import DELETE_FIELD

from .firestore_reports import REPORT_AUTHORS_COLLECTION, REPORTS_COLLECTION, _client


def main() -> None:
    apply = "--apply" in sys.argv[1:]
    db = _client()
    batch = db.batch()
    pending = 0
    moved = 0
    for snap in db.collection(REPORTS_COLLECTION).stream():
        d = snap.to_dict() or {}
        author = d.get("authorIdPrivate")
        if not isinstance(author, str) or not author:
            continue
        moved += 1
        if not apply:
            continue
        batch.set(
            db.collection(REPORT_AUTHORS_COLLECTION).document(snap.id),
            {
                "authorId": author,
                "geohash": d.get("geohash"),
                "category": d.get("category"),
                "status": d.get("status") or "pending",
                "createdAt": d.get("createdAt"),
            },
            merge=True,
        )
        batch.update(snap.reference, {"authorIdPrivate": DELETE_FIELD})
        pending += 2
        if pending >= 400:
            batch.commit()
            batch = db.batch()
            pending = 0
    if apply and pending:
        batch.commit()
    verb = "migrated" if apply else "would migrate (pass --apply)"
    print(f"{verb}: {moved} reports")


if __name__ == "__main__":
    main()
