import { auth, db } from "@/config/firebase";
import { SIGNUP_PHONE_KEY } from "@/constants/preferences";
import {
  calculateTrustScore,
  reportWeightForLevel,
  type TrustCounts,
  type TrustLevel,
  type TrustResult,
  trustLevel,
} from "@/core/trust";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  where,
  type Timestamp,
} from "firebase/firestore";

export type AchievementState = "earned" | "progress" | "locked";

export type ProfileAchievement = {
  id: string;
  title: string;
  hint: string;
  state: AchievementState;
};

export type ProfileStats = {
  displayName: string;
  phone: string;
  email: string;
  trust: TrustResult;
  safeTripsCompleted: number;
  reportsContributed: number;
  verifiedReports: number;
  accurateReports: number;
  participationWeeks: number;
  achievements: ProfileAchievement[];
};

const EMPTY_COUNTS: TrustCounts = {
  accurateReports: 0,
  verifiedReports: 0,
  participationWeeks: 0,
  spamReports: 0,
  fakeReports: 0,
  locationMismatches: 0,
  deletedReports: 0,
};

const QUERY_TIMEOUT_MS = 6_000;

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function weekKey(ms: number): string {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1));
  const day = Math.floor((d.getTime() - start.getTime()) / 86_400_000);
  const week = Math.floor(day / 7) + 1;
  return `${year}-W${week}`;
}

function createdAtMs(value: unknown): number {
  if (
    value &&
    typeof value === "object" &&
    "toMillis" in value &&
    typeof (value as Timestamp).toMillis === "function"
  ) {
    return (value as Timestamp).toMillis();
  }
  return 0;
}

function defaultTrust(): TrustResult {
  return {
    score: 50,
    level: "standard",
    reportWeight: reportWeightForLevel("standard"),
  };
}

function buildAchievements(input: {
  reportsContributed: number;
  verifiedReports: number;
  participationWeeks: number;
  safeTripsCompleted: number;
  level: TrustLevel;
}): ProfileAchievement[] {
  const nightTarget = 5;
  const weekTarget = 4;
  const safeHundred = 100;

  return [
    {
      id: "a1",
      title: "First report",
      hint: "Filed your first community report",
      state: input.reportsContributed >= 1 ? "earned" : "locked",
    },
    {
      id: "a2",
      title: "Night walker",
      hint: `${Math.min(input.safeTripsCompleted, nightTarget)} / ${nightTarget} Safe Walks completed`,
      state:
        input.safeTripsCompleted >= nightTarget
          ? "earned"
          : input.safeTripsCompleted > 0
            ? "progress"
            : "locked",
    },
    {
      id: "a3",
      title: "Verified voice",
      hint: "2 reports confirmed accurate",
      state:
        input.verifiedReports >= 2
          ? "earned"
          : input.verifiedReports > 0
            ? "progress"
            : "locked",
    },
    {
      id: "a4",
      title: "Guardian ally",
      hint: "Reach Guardian trust level",
      state: input.level === "guardian" ? "earned" : "locked",
    },
    {
      id: "a5",
      title: "Week streak",
      hint: `${Math.min(input.participationWeeks, weekTarget)} / ${weekTarget} participation weeks`,
      state:
        input.participationWeeks >= weekTarget
          ? "earned"
          : input.participationWeeks > 0
            ? "progress"
            : "locked",
    },
    {
      id: "a6",
      title: "Safe hundred",
      hint: "Complete 100 Safe Walks",
      state:
        input.safeTripsCompleted >= safeHundred
          ? "earned"
          : input.safeTripsCompleted > 0
            ? "progress"
            : "locked",
    },
  ];
}

async function loadReportActivity(uid: string): Promise<{
  counts: TrustCounts;
  reportsContributed: number;
}> {
  const counts: TrustCounts = { ...EMPTY_COUNTS };
  const weeks = new Set<string>();

  try {
    const reportsSnap = await withTimeout(
      getDocs(
        query(
          collection(db, "report_authors"),
          where("authorId", "==", uid),
          orderBy("createdAt", "desc"),
          limit(200),
        ),
      ),
      QUERY_TIMEOUT_MS,
      "profileReports",
    );

    for (const row of reportsSnap.docs) {
      const status = String(row.get("status") ?? "pending");
      const ms = createdAtMs(row.get("createdAt"));
      if (ms > 0) weeks.add(weekKey(ms));

      if (status === "verified") {
        counts.verifiedReports += 1;
        counts.accurateReports += 1;
      } else if (status === "rejected") {
        counts.spamReports += 1;
      } else if (status === "deleted") {
        counts.deletedReports += 1;
      }
    }
    counts.participationWeeks = weeks.size;

    try {
      const logsSnap = await withTimeout(
        getDocs(
          query(
            collection(db, "trust_logs"),
            where("userId", "==", uid),
            limit(100),
          ),
        ),
        QUERY_TIMEOUT_MS,
        "profileTrustLogs",
      );
      for (const row of logsSnap.docs) {
        const reason = String(row.get("reason") ?? "");
        if (reason === "location_mismatch") counts.locationMismatches += 1;
        if (reason === "fake") counts.fakeReports += 1;
        if (reason === "spam") counts.spamReports += 1;
      }
    } catch {
      // optional enrichment
    }

    return { counts, reportsContributed: reportsSnap.size };
  } catch (error) {
    console.warn("Profile reports unavailable:", error);
    return { counts: { ...EMPTY_COUNTS }, reportsContributed: 0 };
  }
}

async function countCompletedSafeTrips(uid: string): Promise<number> {
  try {
    // Owner-scoped: rules hide other people's closed sessions, so a participantIds query would be denied.
    const snap = await withTimeout(
      getDocs(
        query(
          collection(db, "routes"),
          where("userId", "==", uid),
          where("state", "==", "completed"),
          limit(100),
        ),
      ),
      QUERY_TIMEOUT_MS,
      "profileRoutes",
    );
    return snap.docs.filter((row) => {
      const kind = String(row.get("kind") ?? "safe_walk");
      return kind === "safe_walk" || kind === "live_share";
    }).length;
  } catch (error) {
    console.warn("Profile safe trips unavailable:", error);
    return 0;
  }
}

function statsFromAuthUser(
  overrides?: Partial<ProfileStats>,
): ProfileStats {
  const user = auth.currentUser;
  const trust = overrides?.trust ?? defaultTrust();
  const safeTripsCompleted = overrides?.safeTripsCompleted ?? 0;
  const reportsContributed = overrides?.reportsContributed ?? 0;
  const verifiedReports = overrides?.verifiedReports ?? 0;
  const accurateReports = overrides?.accurateReports ?? 0;
  const participationWeeks = overrides?.participationWeeks ?? 0;

  return {
    displayName:
      overrides?.displayName ||
      user?.displayName ||
      user?.email?.split("@")[0] ||
      "SafeRoute user",
    phone:
      overrides?.phone ||
      user?.phoneNumber ||
      user?.email ||
      "Add phone in account",
    email: overrides?.email || user?.email || "",
    trust,
    safeTripsCompleted,
    reportsContributed,
    verifiedReports,
    accurateReports,
    participationWeeks,
    achievements:
      overrides?.achievements ??
      buildAchievements({
        reportsContributed,
        verifiedReports,
        participationWeeks,
        safeTripsCompleted,
        level: trust.level,
      }),
  };
}

/**
 * Loads Profile trust level, report contribution, and Safe Walk stats.
 * Never hangs the UI: every Firestore call is timed out and soft-fails.
 */
export async function loadProfileStats(): Promise<ProfileStats | null> {
  const user = auth.currentUser;
  if (!user) return null;

  const uid = user.uid;
  const userRef = doc(db, "users", uid);

  const storedPhone = await AsyncStorage.getItem(SIGNUP_PHONE_KEY).catch(
    () => null,
  );

  let data: Record<string, unknown> = {};
  let userSnapExists = false;

  try {
    const userSnap = await withTimeout(
      getDoc(userRef),
      QUERY_TIMEOUT_MS,
      "profileUserDoc",
    );
    userSnapExists = userSnap.exists();
    data = userSnap.data() ?? {};
  } catch (error) {
    console.warn("Profile user doc unavailable:", error);
  }

  const [activity, safeTripsCompleted] = await Promise.all([
    loadReportActivity(uid),
    countCompletedSafeTrips(uid),
  ]);

  const { counts, reportsContributed } = activity;
  const computed = calculateTrustScore(counts);
  const storedScore =
    typeof data.trustScore === "number" ? data.trustScore : null;
  const storedLevel =
    typeof data.trustLevel === "string" ? (data.trustLevel as TrustLevel) : null;

  const hasActivity =
    reportsContributed > 0 ||
    counts.locationMismatches > 0 ||
    counts.fakeReports > 0;

  const resolved: TrustResult = hasActivity
    ? computed
    : storedScore != null
      ? (() => {
          const level = storedLevel ?? trustLevel(storedScore);
          return {
            score: storedScore,
            level,
            reportWeight: reportWeightForLevel(level),
          };
        })()
      : defaultTrust();

  // Best-effort sync; never block the Profile render on write.
  if (
    !userSnapExists ||
    data.trustScore !== resolved.score ||
    data.trustLevel !== resolved.level
  ) {
    void withTimeout(
      setDoc(
        userRef,
        {
          trustScore: resolved.score,
          trustLevel: resolved.level,
          updatedAt: new Date(),
        },
        { merge: true },
      ),
      QUERY_TIMEOUT_MS,
      "profileTrustWrite",
    ).catch(console.warn);
  }

  const displayName =
    (typeof data.displayName === "string" && data.displayName.trim()) ||
    user.displayName ||
    user.email?.split("@")[0] ||
    "SafeRoute user";

  const phoneFromDoc =
    typeof data.phone === "string" && data.phone.trim()
      ? data.phone.trim()
      : "";
  const phone =
    user.phoneNumber ||
    phoneFromDoc ||
    (storedPhone ? `+91 ${storedPhone}` : "") ||
    user.email ||
    "Add phone in account";

  return statsFromAuthUser({
    displayName,
    phone,
    email: user.email ?? "",
    trust: resolved,
    safeTripsCompleted,
    reportsContributed,
    verifiedReports: counts.verifiedReports,
    accurateReports: counts.accurateReports,
    participationWeeks: counts.participationWeeks,
    achievements: buildAchievements({
      reportsContributed,
      verifiedReports: counts.verifiedReports,
      participationWeeks: counts.participationWeeks,
      safeTripsCompleted,
      level: resolved.level,
    }),
  });
}
