import { auth, db } from "@/config/firebase";
import { onAuthStateChanged } from "firebase/auth";
import {
  collection,
  limit,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
import { useEffect, useState } from "react";

const OPEN_STATES = ["active", "check_in_pending", "sos"];

export type MyOpenSafeWalk = {
  id: string;
  state: string;
  destinationLabel: string | null;
  destination: { latitude: number; longitude: number } | null;
  startLocation: { latitude: number; longitude: number } | null;
  etaMinutes: number | null;
  createdAtMs: number;
};

function latLng(value: unknown): MyOpenSafeWalk["destination"] {
  const v = value as { latitude?: unknown; longitude?: unknown } | null;
  return typeof v?.latitude === "number" && typeof v?.longitude === "number"
    ? { latitude: v.latitude, longitude: v.longitude }
    : null;
}

/** The signed-in user's own open Safe Walks, newest first. */
export function useMyOpenSafeWalks(): {
  walks: MyOpenSafeWalk[];
  loading: boolean;
} {
  const [walks, setWalks] = useState<MyOpenSafeWalk[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let stop: (() => void) | null = null;
    const stopAuth = onAuthStateChanged(auth, (user) => {
      stop?.();
      stop = null;
      if (!user) {
        setWalks([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      stop = onSnapshot(
        query(
          collection(db, "routes"),
          where("userId", "==", user.uid),
          where("state", "in", OPEN_STATES),
          limit(10),
        ),
        (snap) => {
          setWalks(
            snap.docs
              .map((d) => {
                const data = d.data();
                return {
                  id: d.id,
                  kind: String(data.kind ?? "safe_walk"),
                  state: String(data.state ?? "active"),
                  destinationLabel:
                    typeof data.destinationLabel === "string"
                      ? data.destinationLabel
                      : null,
                  destination: latLng(data.destination),
                  startLocation: latLng(data.startLocation),
                  etaMinutes:
                    typeof data.etaMinutes === "number" ? data.etaMinutes : null,
                  createdAtMs: data.createdAt?.toMillis?.() ?? 0,
                };
              })
              .filter((w) => w.kind === "safe_walk")
              .map(({ kind: _kind, ...rest }) => rest)
              .sort((a, b) => b.createdAtMs - a.createdAtMs),
          );
          setLoading(false);
        },
        (err) => {
          console.warn("[safewalk] open walks watch failed", err);
          setLoading(false);
        },
      );
    });
    return () => {
      stop?.();
      stopAuth();
    };
  }, []);

  return { walks, loading };
}
