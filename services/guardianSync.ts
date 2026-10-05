/**
 * Keeps the locally cached guardian list (AsyncStorage) in sync with the
 * server-side `guardians` connections so every screen sees fresh
 * `guardianUserId` / `verified` values, not just the Guardians tab.
 */
import { auth, db } from "@/config/firebase";
import {
  GUARDIANS_STORAGE_KEY,
  ensurePrimary,
  normalizeGuardians,
  sortGuardians,
  type Guardian,
} from "@/core/guardians";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { onAuthStateChanged } from "firebase/auth";
import {
  collection,
  onSnapshot,
  query,
  where,
  type DocumentData,
} from "firebase/firestore";

type Listener = (list: Guardian[]) => void;

const listeners = new Set<Listener>();
let started = false;

function national(phone: unknown): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function millis(value: unknown): number {
  const ts = value as { toMillis?: () => number } | null;
  return typeof ts?.toMillis === "function" ? ts.toMillis() : 0;
}

export async function readGuardians(): Promise<Guardian[]> {
  try {
    const raw = await AsyncStorage.getItem(GUARDIANS_STORAGE_KEY);
    return sortGuardians(ensurePrimary(normalizeGuardians(raw ? JSON.parse(raw) : [])));
  } catch {
    return [];
  }
}

export async function writeGuardians(list: Guardian[]): Promise<Guardian[]> {
  const sorted = sortGuardians(ensurePrimary(list));
  await AsyncStorage.setItem(GUARDIANS_STORAGE_KEY, JSON.stringify(sorted));
  listeners.forEach((listener) => listener(sorted));
  return sorted;
}

export function subscribeGuardians(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Applies server connection docs to the local list. Guardians saved before the
 * backend was reachable have no connectionId; link those by phone number.
 */
export function mergeConnections(
  list: Guardian[],
  docs: Array<{ id: string; data: DocumentData }>,
): Guardian[] {
  const byId = new Map(docs.map((item) => [item.id, item.data]));
  const claimed = new Set(
    list.map((g) => g.connectionId).filter((id): id is string => Boolean(id && byId.has(id))),
  );
  const rank = (status: unknown) => (status === "accepted" ? 2 : status === "pending" ? 1 : 0);
  return list.map((guardian) => {
    let connectionId = guardian.connectionId;
    let connection = connectionId ? byId.get(connectionId) : undefined;
    if (!connection) {
      const phone = national(guardian.phone);
      const candidate = docs
        .filter(
          (item) =>
            !claimed.has(item.id) &&
            item.data.status !== "revoked" &&
            national(item.data.inviteePhone) === phone,
        )
        .sort(
          (a, b) =>
            rank(b.data.status) - rank(a.data.status) ||
            millis(b.data.updatedAt) - millis(a.data.updatedAt),
        )[0];
      if (candidate) {
        connectionId = candidate.id;
        connection = candidate.data;
        claimed.add(candidate.id);
      }
    }
    if (!connection) return guardian;
    const status = connection.status as Guardian["connectionStatus"];
    return {
      ...guardian,
      connectionId,
      verified: status === "accepted",
      connectionStatus: status,
      guardianUserId:
        status === "accepted" && typeof connection.guardianUserId === "string"
          ? connection.guardianUserId
          : undefined,
    };
  });
}

/** Accepted guardian account ids, primary first. */
export function connectedGuardianIds(list: Guardian[]): string[] {
  return sortGuardians(list)
    .filter((g) => g.verified && g.guardianUserId)
    .map((g) => g.guardianUserId as string);
}

/** Call once from the root layout. Safe to call repeatedly. */
export function startGuardianSync(): () => void {
  if (started) return () => undefined;
  started = true;
  let stopConnections: (() => void) | undefined;
  const stopAuth = onAuthStateChanged(auth, (user) => {
    stopConnections?.();
    stopConnections = undefined;
    if (!user) return;
    stopConnections = onSnapshot(
      query(collection(db, "guardians"), where("userId", "==", user.uid)),
      async (snapshot) => {
        const docs = snapshot.docs.map((item) => ({ id: item.id, data: item.data() }));
        const current = await readGuardians();
        const next = mergeConnections(current, docs);
        if (JSON.stringify(next) !== JSON.stringify(current)) {
          await writeGuardians(next);
        }
      },
      (error) => console.warn("Guardian sync failed", error),
    );
  });
  return () => {
    started = false;
    stopAuth();
    stopConnections?.();
  };
}
