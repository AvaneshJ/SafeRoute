"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.expireStaleSafetySessions = exports.expireOldReports = exports.updateCrowdDensity = exports.clearNotifications = exports.markNotificationRead = exports.publishEmergencyEvent = exports.activateSOS = exports.safeWalkCheckin = exports.publishLiveShareEvent = exports.publishSafeWalkEvent = exports.onLiveRouteLocationUpdated = exports.publishSafetyEvent = exports.startLiveShare = exports.startSafeWalk = exports.revokeGuardian = exports.acceptGuardianInvite = exports.inviteGuardian = exports.createGuardianInvite = exports.moderateReport = exports.onReportCreated = exports.verifyReport = exports.generateRoutes = exports.calculateSafetyScore = void 0;
exports.sendGuardianNotification = sendGuardianNotification;
const https_1 = require("firebase-functions/v2/https");
const scheduler_1 = require("firebase-functions/v2/scheduler");
const firestore_1 = require("firebase-functions/v2/firestore");
const app_1 = require("firebase-admin/app");
const firestore_2 = require("firebase-admin/firestore");
const node_crypto_1 = require("node:crypto");
const safetyScore_1 = require("../../core/safetyScore");
const geohash_1 = require("../../core/geohash");
const trust_1 = require("../../core/trust");
const routeOptimization_1 = require("../../core/routeOptimization");
(0, app_1.initializeApp)();
const db = (0, firestore_2.getFirestore)();
db.settings({ ignoreUndefinedProperties: true });
// Must match the Firestore database location; triggers can't run elsewhere.
const FIRESTORE_REGION = "asia-south1";
function requireAuth(uid) {
    if (!uid)
        throw new https_1.HttpsError("unauthenticated", "Sign in is required.");
    return uid;
}
/** GET /safety-score — callable calculateSafetyScore */
exports.calculateSafetyScore = (0, https_1.onCall)(async (request) => {
    requireAuth(request.auth?.uid);
    const { latitude, longitude, departAtMs } = request.data;
    const when = new Date(departAtMs);
    const geohash = (0, geohash_1.encodeGeohash)(latitude, longitude, 7);
    const snap = await db.collection("safety_scores").doc(geohash).get();
    const stored = snap.data();
    const result = (0, safetyScore_1.calculateSafetyScore)({
        hour: when.getHours() + when.getMinutes() / 60,
        dayOfWeek: when.getDay(),
        communityRating: stored?.communityRating ?? null,
        crowdDensity: stored?.crowdDensity ?? null,
        streetLighting: stored?.streetLighting ?? null,
        visibilityKm: stored?.visibilityKm ?? null,
        policeDistanceM: stored?.policeDistanceM ?? null,
        cctv: stored?.cctv ?? null,
        verifiedIncidents30d: stored?.verifiedIncidents30d ?? null,
        historicalReports: stored?.historicalReports ?? null,
        xgbRisk: stored?.xgbRisk ?? null,
        xgbConfidence: stored?.xgbConfidence ?? null,
    });
    return {
        score: result.score,
        confidence: result.confidence,
        geohash,
        modelApplied: result.modelApplied,
    };
});
/** POST /route — callable generateRoutes. The client also runs the same planner. */
exports.generateRoutes = (0, https_1.onCall)(async (request) => {
    requireAuth(request.auth?.uid);
    const { origin, destination, departAtMs } = request.data;
    const originHash = (0, geohash_1.encodeGeohash)(origin.latitude, origin.longitude, 6);
    const segments = await db
        .collection("road_segments")
        .where("geohash6", "==", originHash)
        .limit(400)
        .get();
    const nodes = {};
    const edges = [];
    segments.docs.forEach((doc) => {
        const row = doc.data();
        const fromId = String(row.fromNodeId);
        const toId = String(row.toNodeId);
        nodes[fromId] = {
            id: fromId,
            latitude: row.fromLat,
            longitude: row.fromLng,
        };
        nodes[toId] = {
            id: toId,
            latitude: row.toLat,
            longitude: row.toLng,
        };
        edges.push({
            id: doc.id,
            from: fromId,
            to: toId,
            lengthM: row.lengthM,
            speedKmh: row.speedKmh,
            safetyScore: row.safetyScore,
            lighting: row.lighting ?? null,
            crowd: row.crowd ?? null,
        });
    });
    if (edges.length === 0) {
        return {
            routes: [],
            segmentCount: 0,
            departAtMs,
            destination,
        };
    }
    const nearest = (point) => {
        let bestId = Object.keys(nodes)[0];
        let best = Infinity;
        for (const node of Object.values(nodes)) {
            const distance = (0, routeOptimization_1.haversineM)(point, node);
            if (distance < best) {
                best = distance;
                bestId = node.id;
            }
        }
        return bestId;
    };
    const searched = (0, routeOptimization_1.generateRoutes)({ nodes, edges }, nearest(origin), nearest(destination));
    const cards = ["safest", "balanced", "fastest"].flatMap((mode) => {
        const path = searched[mode];
        if (!path)
            return [];
        return [
            {
                mode,
                title: mode === "safest"
                    ? "Safest Route"
                    : mode === "balanced"
                        ? "Balanced Route"
                        : "Fastest Route",
                distanceM: path.distanceM,
                etaMinutes: path.etaMinutes,
                safetyScore: path.safetyScore,
                lighting: path.lighting,
                crowd: path.crowd,
                confidence: null,
                nodeIds: path.nodeIds,
            },
        ];
    });
    return { routes: cards, segmentCount: edges.length, departAtMs };
});
/** Private report → author mapping. Readable by the author only. */
const REPORT_AUTHORS = "report_authors";
async function reportAuthorId(reportId) {
    const snap = await db.collection(REPORT_AUTHORS).doc(reportId).get();
    const id = snap.get("authorId");
    return typeof id === "string" && id ? id : null;
}
/** POST /report — writes the report, then verifyReport adjusts trust. */
exports.verifyReport = (0, https_1.onCall)(async (request) => {
    const uid = requireAuth(request.auth?.uid);
    const data = request.data;
    if (data.accuracyM > 100) {
        throw new https_1.HttpsError("failed-precondition", "Location accuracy is coarser than 100 m.");
    }
    const distanceM = (0, routeOptimization_1.haversineM)({ latitude: data.deviceLatitude, longitude: data.deviceLongitude }, { latitude: data.latitude, longitude: data.longitude });
    if ((0, trust_1.isLocationMismatch)(distanceM)) {
        await db.collection("trust_logs").add({
            userId: uid,
            delta: -10,
            reason: "location_mismatch",
            createdAt: firestore_2.FieldValue.serverTimestamp(),
        });
        throw new https_1.HttpsError("failed-precondition", "Report location does not match the device.");
    }
    const recent = await db
        .collection(REPORT_AUTHORS)
        .where("authorId", "==", uid)
        .orderBy("createdAt", "desc")
        .limit(5)
        .get();
    const stamps = recent.docs
        .map((doc) => doc.get("createdAt")?.toMillis?.() ?? 0)
        .filter((ms) => ms > 0);
    if ((0, trust_1.isRateLimited)(stamps, Date.now())) {
        throw new https_1.HttpsError("resource-exhausted", "Report limit reached for this hour.");
    }
    const geohash = (0, geohash_1.encodeGeohash)(data.latitude, data.longitude, 7);
    const last = recent.docs[0];
    if (last &&
        (0, trust_1.isDuplicateReport)({
            lastGeohash: last.get("geohash") ?? null,
            lastCategory: last.get("category") ?? null,
            lastTimestampMs: last.get("createdAt")?.toMillis?.() ?? null,
            geohash,
            category: data.category,
            nowMs: Date.now(),
        })) {
        throw new https_1.HttpsError("already-exists", "A matching report was filed in the last hour.");
    }
    // The author id never goes on the public report doc; it lives in a private mirror.
    const ref = db.collection("reports").doc();
    const batch = db.batch();
    batch.set(db.collection(REPORT_AUTHORS).doc(ref.id), {
        authorId: uid,
        geohash,
        category: data.category,
        status: "pending",
        createdAt: firestore_2.FieldValue.serverTimestamp(),
    });
    batch.set(ref, {
        authorId: data.anonymous ? null : uid,
        anonymous: data.anonymous,
        latitude: data.latitude,
        longitude: data.longitude,
        geohash,
        category: data.category,
        severity: data.severity,
        note: data.note,
        status: "pending",
        createdAt: firestore_2.FieldValue.serverTimestamp(),
    });
    await batch.commit();
    return { reportId: ref.id, accepted: true, reason: null };
});
/**
 * Phase 5 — roll a report into safety_scores/{geohash7}.
 * Pending reports still contribute (lower weight); verified get a 1.5× boost.
 */
async function aggregateCommunityCell(report) {
    const geohash = String(report.geohash || "");
    if (!geohash)
        return;
    const severity = Number(report.severity) || 3;
    const status = String(report.status || "pending");
    if (status === "rejected" || status === "expired")
        return;
    const verified = status === "verified";
    const weight = verified ? 1.5 : 1.0;
    const rating = Math.min(5, Math.max(1, 6 - severity)); // stars
    const ref = db.collection("safety_scores").doc(geohash);
    await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const prev = snap.data() || {};
        const prevWeight = Number(prev.communityWeight || 0);
        const prevRating = Number(prev.communityRating || 0);
        const nextWeight = prevWeight + weight;
        const nextRating = nextWeight > 0
            ? (prevRating * prevWeight + rating * weight) / nextWeight
            : rating;
        const incidents = Number(prev.verifiedIncidents30d || 0) + (severity >= 4 ? weight : 0);
        tx.set(ref, {
            communityRating: Math.round(nextRating * 100) / 100,
            communityWeight: nextWeight,
            verifiedIncidents30d: Math.round(incidents * 100) / 100,
            historicalReports: Number(prev.historicalReports || 0) + 1,
            updatedAt: firestore_2.FieldValue.serverTimestamp(),
            source: "community_intelligence",
        }, { merge: true });
    });
}
exports.onReportCreated = (0, firestore_1.onDocumentCreated)({ document: "reports/{reportId}", region: FIRESTORE_REGION }, async (event) => {
    const report = event.data?.data();
    if (!report)
        return;
    const userId = await reportAuthorId(event.params.reportId);
    if (!userId)
        return;
    await createAndDispatchNotification({
        userId,
        fromUserId: userId,
        subjectId: event.params.reportId,
        eventId: event.params.reportId,
        type: "report_pending",
        title: "Report received",
        body: "Your safety report is being verified.",
        route: "/(tabs)/alerts",
        data: {
            reportId: event.params.reportId,
            geohash: String(report.geohash ?? ""),
        },
    });
    // Soft-learn immediately so heat / scores react before manual verify
    try {
        await aggregateCommunityCell(report);
    }
    catch (err) {
        console.error("aggregateCommunityCell failed", err);
    }
});
/** Phase 5 — mark a report verified/rejected (Admin SDK; call from trusted moderation). */
exports.moderateReport = (0, https_1.onCall)(async (request) => {
    requireAuth(request.auth?.uid);
    const { reportId, status } = request.data;
    if (!reportId || (status !== "verified" && status !== "rejected")) {
        throw new https_1.HttpsError("invalid-argument", "reportId and status required.");
    }
    const ref = db.collection("reports").doc(reportId);
    const snap = await ref.get();
    if (!snap.exists)
        throw new https_1.HttpsError("not-found", "Report not found.");
    const prev = snap.data() || {};
    await ref.update({
        status,
        moderatedAt: firestore_2.FieldValue.serverTimestamp(),
        moderatedBy: request.auth.uid,
    });
    await db
        .collection(REPORT_AUTHORS)
        .doc(reportId)
        .set({ status }, { merge: true });
    const authorId = await reportAuthorId(reportId);
    if (status === "verified" && authorId) {
        await aggregateCommunityCell({ ...prev, status: "verified" });
        await db.collection("trust_logs").add({
            userId: authorId,
            delta: 8,
            reason: "accurate_report",
            createdAt: firestore_2.FieldValue.serverTimestamp(),
        });
    }
    return { reportId, status };
});
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
function requiredString(value, name, max = 256) {
    if (typeof value !== "string" || !value.trim() || value.length > max) {
        throw new https_1.HttpsError("invalid-argument", `${name} is required.`);
    }
    return value.trim();
}
function optionalString(value, max = 256) {
    if (value == null || value === "")
        return null;
    if (typeof value !== "string" || value.length > max) {
        throw new https_1.HttpsError("invalid-argument", "Invalid string value.");
    }
    return value.trim();
}
function eventId(value) {
    const id = requiredString(value, "eventId", 128);
    if (!EVENT_ID_RE.test(id)) {
        throw new https_1.HttpsError("invalid-argument", "eventId contains unsupported characters.");
    }
    return id;
}
function validLocation(value) {
    if (value == null || typeof value !== "object")
        return null;
    const row = value;
    const latitude = row.latitude;
    const longitude = row.longitude;
    if (typeof latitude !== "number" ||
        typeof longitude !== "number" ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180) {
        throw new https_1.HttpsError("invalid-argument", "A valid location is required.");
    }
    return {
        latitude,
        longitude,
        accuracyM: typeof row.accuracyM === "number" && Number.isFinite(row.accuracyM)
            ? Math.max(0, row.accuracyM)
            : null,
        recordedAtMs: typeof row.recordedAtMs === "number" && Number.isFinite(row.recordedAtMs)
            ? row.recordedAtMs
            : Date.now(),
    };
}
const MAX_ROUTE_POINTS = 400;
function validPath(value) {
    if (!Array.isArray(value) || value.length < 2)
        return null;
    const points = value
        .map((point) => validLocation(point))
        .filter((point) => point !== null)
        .map(({ latitude, longitude }) => ({
        latitude: Math.round(latitude * 1e6) / 1e6,
        longitude: Math.round(longitude * 1e6) / 1e6,
    }));
    if (points.length < 2)
        return null;
    if (points.length <= MAX_ROUTE_POINTS)
        return points;
    const step = (points.length - 1) / (MAX_ROUTE_POINTS - 1);
    return Array.from({ length: MAX_ROUTE_POINTS }, (_, i) => points[Math.round(i * step)]);
}
function sessionCopy(kind, type, walkerName, destinationLabel) {
    const to = destinationLabel ? ` to ${destinationLabel}` : "";
    const at = destinationLabel ? ` at ${destinationLabel}` : "";
    const walk = kind === "safe_walk";
    switch (type) {
        case "started":
            return walk
                ? {
                    title: "Safe Walk started",
                    body: `${walkerName} started a Safe Walk${to}. Tap to follow their live location.`,
                }
                : {
                    title: `${walkerName} started a trip`,
                    body: `Follow their live route${to} in SafeRoute.`,
                };
        case "arrived":
            return {
                title: `${walkerName} arrived safely`,
                body: walk
                    ? `${walkerName} completed their Safe Walk${at}.`
                    : `${walkerName} reached their destination${at ? at : ""}.`,
            };
        case "checkin_failed":
            return {
                title: "Safety check-in missed",
                body: `${walkerName} didn't respond to a safety check-in. Open to see their last location.`,
            };
        case "checkin_ok":
            return {
                title: `${walkerName} says they're safe`,
                body: walk
                    ? `${walkerName} confirmed they're okay after the missed check-in. Their Safe Walk continues.`
                    : `${walkerName} confirmed they're okay after the missed check-in.`,
            };
        case "ended":
            return {
                title: walk ? `${walkerName} ended their Safe Walk` : `${walkerName} ended their trip`,
                body: "They stopped sharing their live location. Check in with them if you're unsure.",
            };
        case "cancelled":
            return {
                title: walk ? "Safe Walk cancelled" : "Trip cancelled",
                body: `${walkerName} ended the session before arriving.`,
            };
        case "guardian_acknowledged":
            return {
                title: "Your guardian is watching",
                body: "A guardian opened your live location.",
            };
        default:
            return {
                title: walk ? "Safe Walk update" : "Trip update",
                body: "Open SafeRoute for the latest safety update.",
            };
    }
}
function hash(value) {
    return (0, node_crypto_1.createHash)("sha256").update(value).digest("hex");
}
function documentId(prefix, uid, id) {
    return `${prefix}_${hash(`${uid}:${id}`).slice(0, 40)}`;
}
function uniqueStrings(value) {
    if (!Array.isArray(value))
        return [];
    return [...new Set(value.filter((item) => typeof item === "string" && item.length > 0 && item.length <= 128))];
}
async function acceptedGuardianIds(ownerId, requestedIds) {
    const snap = await db
        .collection("guardians")
        .where("userId", "==", ownerId)
        .where("status", "==", "accepted")
        .get();
    const accepted = new Set(snap.docs
        .map((doc) => doc.get("guardianUserId"))
        .filter((id) => typeof id === "string" && id.length > 0));
    if (!requestedIds || requestedIds.length === 0)
        return [...accepted];
    // Clients cache guardian ids locally; drop revoked/unknown ones instead of
    // failing the whole session, and fall back to everyone still accepted.
    const requested = [...new Set(requestedIds)].filter((id) => accepted.has(id));
    return requested.length > 0 ? requested : [...accepted];
}
/** Indian mobile numbers are stored as +91XXXXXXXXXX on users.phone. */
function phoneVariants(raw) {
    const digits = raw.replace(/\D/g, "");
    const national = digits.length > 10 ? digits.slice(-10) : digits;
    const variants = new Set([raw]);
    if (national.length === 10) {
        variants.add(`+91${national}`);
        variants.add(national);
        variants.add(`91${national}`);
    }
    return [...variants].slice(0, 10);
}
async function findUserIdByPhone(phone) {
    const variants = phoneVariants(phone);
    for (const field of ["phone", "phoneNumber"]) {
        const match = await db
            .collection("users")
            .where(field, "in", variants)
            .limit(1)
            .get();
        if (!match.empty)
            return match.docs[0].id;
    }
    return null;
}
function isExpoToken(token) {
    return (typeof token === "string" &&
        /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(token));
}
async function sendExpo(tokens, title, body, data) {
    if (tokens.length === 0)
        return { status: "no_push_token", ticketIds: [] };
    try {
        const response = await fetch(EXPO_PUSH_URL, {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
            },
            body: JSON.stringify(tokens.map((to) => ({
                to,
                title,
                body,
                data,
                sound: "default",
                priority: "high",
                channelId: "safety-alerts",
            }))),
        });
        if (!response.ok) {
            return {
                status: "failed",
                ticketIds: [],
                error: `Expo Push Service returned HTTP ${response.status}.`,
            };
        }
        const payload = (await response.json());
        const tickets = Array.isArray(payload.data) ? payload.data : [];
        const ticketIds = tickets
            .map((ticket) => ticket.id)
            .filter((id) => typeof id === "string");
        // Tickets come back in request order.
        const deadTokens = tickets
            .map((ticket, i) => ticket.details?.error === "DeviceNotRegistered" ? tokens[i] : null)
            .filter((token) => typeof token === "string");
        if (tickets.some((ticket) => ticket.status === "ok")) {
            return { status: "sent", ticketIds, deadTokens };
        }
        const invalid = tickets.length > 0 && deadTokens.length === tickets.length;
        return {
            status: invalid ? "invalid_push_token" : "failed",
            ticketIds,
            deadTokens,
            error: tickets.map((ticket) => ticket.message).filter(Boolean).join("; ") ||
                "Expo Push Service did not accept the notification.",
        };
    }
    catch (error) {
        return {
            status: "failed",
            ticketIds: [],
            error: error instanceof Error ? error.message : "Push delivery failed.",
        };
    }
}
async function createAndDispatchNotification(input) {
    const id = input.eventId
        ? documentId("notification", input.userId, `${input.subjectId}:${input.type}:${input.eventId}`)
        : db.collection("notifications").doc().id;
    const ref = db.collection("notifications").doc(id);
    const existing = await ref.get();
    if (existing.exists && existing.get("delivery")) {
        return existing.get("delivery");
    }
    await ref.set({
        userId: input.userId,
        fromUserId: input.fromUserId,
        subjectId: input.subjectId,
        type: input.type,
        title: input.title,
        body: input.body,
        route: input.route,
        data: input.data,
        readAt: null,
        createdAt: firestore_2.FieldValue.serverTimestamp(),
    }, { merge: true });
    const user = await db.collection("users").doc(input.userId).get();
    const allTokens = [
        ...(Array.isArray(user.get("expoPushTokens")) ? user.get("expoPushTokens") : []),
        user.get("expoPushToken"),
    ];
    const tokens = [...new Set(allTokens.filter(isExpoToken))].slice(0, 100);
    const result = await sendExpo(tokens, input.title, input.body, {
        ...input.data,
        type: input.type,
        route: input.route,
        notificationId: id,
    });
    if (result.deadTokens && result.deadTokens.length > 0) {
        await user.ref
            .update({
            expoPushTokens: firestore_2.FieldValue.arrayRemove(...result.deadTokens),
        })
            .catch((error) => console.warn("Could not prune push tokens", error));
    }
    const delivery = {
        userId: input.userId,
        notificationId: id,
        status: result.status,
        sms_required: result.status !== "sent",
        ticketIds: result.ticketIds,
        ...(result.error ? { error: result.error } : {}),
    };
    await ref.set({ delivery, deliveredAt: firestore_2.FieldValue.serverTimestamp() }, { merge: true });
    return delivery;
}
async function notifyParticipants(input) {
    const recipients = input.participantIds.filter((id) => input.includeOwner || id !== input.ownerId);
    return Promise.all(recipients.map((userId) => createAndDispatchNotification({
        userId,
        fromUserId: input.ownerId,
        subjectId: input.subjectId,
        eventId: input.eventId,
        type: input.type,
        title: input.title,
        body: input.body,
        route: input.route,
        data: { subjectId: input.subjectId, type: input.type, ...(input.data ?? {}) },
    })));
}
const INVITE_BASE_URL = process.env.INVITE_BASE_URL ?? "https://saferoute-8bc4f.web.app/invite";
function inviteLinks(inviteId, token) {
    const query = `inviteId=${encodeURIComponent(inviteId)}&token=${encodeURIComponent(token)}`;
    return { inviteUrl: `${INVITE_BASE_URL}?${query}`, appRoute: `/GuardianInvite?${query}` };
}
function sendInvitePush(input) {
    return createAndDispatchNotification({
        userId: input.guardianUserId,
        fromUserId: input.ownerId,
        subjectId: input.inviteId,
        eventId: `${input.inviteId}-${hash(input.token).slice(0, 12)}`,
        type: "guardian_invite",
        title: "Guardian invitation",
        body: `${input.ownerName || "Someone"} wants you as their SafeRoute guardian. Tap to accept.`,
        route: inviteLinks(input.inviteId, input.token).appRoute,
        data: { inviteId: input.inviteId },
    });
}
/** Creates a token-bound guardian invitation. Guardian writes are callable-only. */
exports.createGuardianInvite = (0, https_1.onCall)(async (request) => {
    const uid = requireAuth(request.auth?.uid);
    const data = (request.data ?? {});
    const existingId = optionalString(data.connectionId, 128);
    if (existingId) {
        const ref = db.collection("guardians").doc(existingId);
        const snap = await ref.get();
        if (!snap.exists || snap.get("userId") !== uid) {
            throw new https_1.HttpsError("not-found", "Guardian invitation not found.");
        }
        if (snap.get("status") === "accepted") {
            throw new https_1.HttpsError("failed-precondition", "Guardian is already connected.");
        }
        const inviteToken = (0, node_crypto_1.randomBytes)(32).toString("base64url");
        const expiresAtMs = Date.now() + INVITE_TTL_MS;
        await ref.update({
            status: "pending",
            inviteTokenHash: hash(inviteToken),
            expiresAt: firestore_2.Timestamp.fromMillis(expiresAtMs),
            updatedAt: firestore_2.FieldValue.serverTimestamp(),
        });
        const knownGuardian = optionalString(snap.get("guardianUserId"), 128);
        const delivery = knownGuardian
            ? await sendInvitePush({
                guardianUserId: knownGuardian,
                ownerId: uid,
                ownerName: optionalString(snap.get("ownerName"), 100),
                inviteId: ref.id,
                token: inviteToken,
            })
            : null;
        return {
            inviteId: ref.id,
            inviteToken,
            inviteUrl: inviteLinks(ref.id, inviteToken).inviteUrl,
            status: "pending",
            expiresAtMs,
            delivery,
            sms_required: !delivery || delivery.sms_required,
        };
    }
    let guardianUserId = optionalString(data.guardianUserId, 128);
    const email = optionalString(data.email)?.toLowerCase() ?? null;
    const phone = optionalString(data.phone, 32)?.replace(/[^\d+]/g, "") ?? null;
    if (guardianUserId === uid) {
        throw new https_1.HttpsError("invalid-argument", "You cannot invite yourself.");
    }
    if (!guardianUserId && !email && !phone) {
        throw new https_1.HttpsError("invalid-argument", "guardianUserId, email, or phone is required.");
    }
    if (!guardianUserId && email) {
        const match = await db.collection("users").where("email", "==", email).limit(1).get();
        guardianUserId = match.empty ? null : match.docs[0].id;
    }
    if (!guardianUserId && phone) {
        guardianUserId = await findUserIdByPhone(phone);
    }
    if (guardianUserId === uid)
        guardianUserId = null;
    const existing = await db
        .collection("guardians")
        .where("userId", "==", uid)
        .where("status", "in", ["pending", "accepted"])
        .get();
    if (existing.size >= 5) {
        throw new https_1.HttpsError("resource-exhausted", "Guardian limit reached.");
    }
    if (guardianUserId &&
        existing.docs.some((doc) => doc.get("guardianUserId") === guardianUserId)) {
        throw new https_1.HttpsError("already-exists", "This guardian is already invited.");
    }
    const inviteToken = (0, node_crypto_1.randomBytes)(32).toString("base64url");
    const ref = db.collection("guardians").doc();
    const expiresAtMs = Date.now() + INVITE_TTL_MS;
    const ownerName = optionalString((await db.collection("users").doc(uid).get()).get("displayName"), 100);
    await ref.set({
        userId: uid,
        ownerId: uid,
        ownerName,
        guardianUserId,
        inviteeEmail: email,
        inviteePhone: phone,
        displayName: optionalString(data.displayName, 100),
        relationship: optionalString(data.relationship, 50),
        status: "pending",
        inviteTokenHash: hash(inviteToken),
        createdAt: firestore_2.FieldValue.serverTimestamp(),
        updatedAt: firestore_2.FieldValue.serverTimestamp(),
        expiresAt: firestore_2.Timestamp.fromMillis(expiresAtMs),
    });
    const delivery = guardianUserId
        ? await sendInvitePush({
            guardianUserId,
            ownerId: uid,
            ownerName,
            inviteId: ref.id,
            token: inviteToken,
        })
        : null;
    return {
        inviteId: ref.id,
        inviteToken,
        inviteUrl: inviteLinks(ref.id, inviteToken).inviteUrl,
        status: "pending",
        expiresAtMs,
        delivery,
        sms_required: !delivery || delivery.sms_required,
    };
});
exports.inviteGuardian = exports.createGuardianInvite;
exports.acceptGuardianInvite = (0, https_1.onCall)(async (request) => {
    const uid = requireAuth(request.auth?.uid);
    const data = (request.data ?? {});
    const inviteId = requiredString(data.inviteId, "inviteId", 128);
    const token = requiredString(data.inviteToken, "inviteToken", 256);
    const ref = db.collection("guardians").doc(inviteId);
    const now = firestore_2.Timestamp.now();
    const guardianName = optionalString((await db.collection("users").doc(uid).get()).get("displayName"), 100);
    const ownerId = await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        if (!snap.exists)
            throw new https_1.HttpsError("not-found", "Invitation not found.");
        const row = snap.data();
        if (row.status === "accepted" && row.guardianUserId === uid)
            return row.userId;
        if (row.status !== "pending") {
            throw new https_1.HttpsError("failed-precondition", "Invitation is no longer active.");
        }
        if (row.expiresAt instanceof firestore_2.Timestamp && row.expiresAt.toMillis() <= now.toMillis()) {
            throw new https_1.HttpsError("deadline-exceeded", "Invitation has expired.");
        }
        const expected = Buffer.from(String(row.inviteTokenHash), "hex");
        const supplied = Buffer.from(hash(token), "hex");
        if (expected.length !== supplied.length || !(0, node_crypto_1.timingSafeEqual)(expected, supplied)) {
            throw new https_1.HttpsError("permission-denied", "Invitation token is invalid.");
        }
        // Possession of the high-entropy, one-time token is the acceptance proof
        // when the invite was sent to a phone number that is not an auth claim.
        const intended = !row.guardianUserId || row.guardianUserId === uid;
        if (!intended) {
            throw new https_1.HttpsError("permission-denied", "Invitation is intended for another account.");
        }
        transaction.update(ref, {
            guardianUserId: uid,
            guardianName,
            status: "accepted",
            acceptedAt: now,
            updatedAt: now,
            inviteTokenHash: firestore_2.FieldValue.delete(),
        });
        return row.userId;
    });
    await createAndDispatchNotification({
        userId: ownerId,
        fromUserId: uid,
        subjectId: inviteId,
        eventId: `accepted-${inviteId}`,
        type: "guardian_accepted",
        title: "Guardian connected",
        body: `${guardianName || "Your guardian"} accepted your SafeRoute invitation.`,
        route: "/(tabs)/contacts",
        data: { inviteId },
    });
    return { guardianId: inviteId, ownerId, guardianUserId: uid, status: "accepted" };
});
exports.revokeGuardian = (0, https_1.onCall)(async (request) => {
    const uid = requireAuth(request.auth?.uid);
    const guardianId = requiredString(request.data?.guardianId, "guardianId", 128);
    const ref = db.collection("guardians").doc(guardianId);
    const revokedUserId = await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        if (!snap.exists)
            throw new https_1.HttpsError("not-found", "Guardian relationship not found.");
        if (snap.get("userId") !== uid) {
            throw new https_1.HttpsError("permission-denied", "Only the owner can revoke a guardian.");
        }
        transaction.update(ref, {
            status: "revoked",
            revokedAt: firestore_2.FieldValue.serverTimestamp(),
            updatedAt: firestore_2.FieldValue.serverTimestamp(),
            inviteTokenHash: firestore_2.FieldValue.delete(),
        });
        return typeof snap.get("guardianUserId") === "string"
            ? snap.get("guardianUserId")
            : null;
    });
    if (revokedUserId) {
        const [routes, emergencies] = await Promise.all([
            db.collection("routes").where("userId", "==", uid).limit(200).get(),
            db.collection("emergencies").where("userId", "==", uid).limit(200).get(),
        ]);
        // Closed sessions too: a revoked guardian must not keep reading past trips.
        const shared = [...routes.docs, ...emergencies.docs].filter((doc) => {
            const ids = doc.get("participantIds");
            return Array.isArray(ids) && ids.includes(revokedUserId);
        });
        for (let start = 0; start < shared.length; start += 200) {
            const batch = db.batch();
            shared.slice(start, start + 200).forEach((doc) => {
                batch.update(doc.ref, {
                    participantIds: firestore_2.FieldValue.arrayRemove(revokedUserId),
                    guardianUserIds: firestore_2.FieldValue.arrayRemove(revokedUserId),
                    updatedAt: firestore_2.FieldValue.serverTimestamp(),
                });
                batch.set(doc.ref.collection("live").doc("current"), {
                    participantIds: firestore_2.FieldValue.arrayRemove(revokedUserId),
                    updatedAt: firestore_2.FieldValue.serverTimestamp(),
                }, { merge: true });
            });
            await batch.commit();
        }
    }
    return { guardianId, status: "revoked" };
});
async function createSafetySession(ownerId, kind, data) {
    const requested = uniqueStrings(data.guardianUserIds ?? (data.guardianUserId ? [data.guardianUserId] : []));
    const guardianIds = await acceptedGuardianIds(ownerId, requested);
    const idempotencyKey = data.eventId == null ? (0, node_crypto_1.randomUUID)() : eventId(data.eventId);
    const sessionId = documentId(kind, ownerId, idempotencyKey);
    const ref = db.collection("routes").doc(sessionId);
    const location = validLocation(data.location);
    const destination = validLocation(data.destination);
    if (kind === "safe_walk" && !destination) {
        throw new https_1.HttpsError("invalid-argument", "destination is required.");
    }
    const destinationLabel = optionalString(data.destinationLabel, 200) ??
        optionalString(data.destinationName, 200);
    const routePath = validPath(data.routePath);
    const travelMode = optionalString(data.travelMode, 20);
    const participantIds = [ownerId, ...guardianIds];
    const ownerProfile = await db.collection("users").doc(ownerId).get();
    const walkerName = optionalString(data.walkerName, 100) ||
        optionalString(ownerProfile.get("displayName"), 100) ||
        "Someone you trust";
    const created = await db.runTransaction(async (transaction) => {
        const existing = await transaction.get(ref);
        if (existing.exists) {
            if (existing.get("userId") !== ownerId) {
                throw new https_1.HttpsError("permission-denied", "Session ID is already in use.");
            }
            return false;
        }
        const now = firestore_2.FieldValue.serverTimestamp();
        transaction.create(ref, {
            kind,
            userId: ownerId,
            ownerId,
            guardianUserId: guardianIds[0] ?? null,
            guardianUserIds: guardianIds,
            participantIds,
            walkerName,
            destination,
            destinationLabel,
            routePath,
            travelMode,
            startLocation: location,
            etaMinutes: typeof data.etaMinutes === "number" && Number.isFinite(data.etaMinutes)
                ? Math.max(0, data.etaMinutes)
                : null,
            expiresAt: typeof data.expiresAtMs === "number"
                ? firestore_2.Timestamp.fromMillis(data.expiresAtMs)
                : null,
            state: "active",
            lastEventId: idempotencyKey,
            createdAt: now,
            updatedAt: now,
        });
        transaction.create(ref.collection("events").doc(idempotencyKey), {
            eventId: idempotencyKey,
            type: "started",
            actorId: ownerId,
            location,
            createdAt: now,
        });
        transaction.set(ref.collection("live").doc("current"), {
            ownerId,
            participantIds,
            state: "active",
            location,
            eventId: idempotencyKey,
            updatedAt: now,
        });
        return true;
    });
    if (created) {
        await closeSupersededSessions(ownerId, kind, sessionId).catch((error) => console.warn("Closing superseded sessions failed", error));
    }
    const copy = sessionCopy(kind, "started", walkerName, destinationLabel);
    const deliveries = created
        ? await notifyParticipants({
            ownerId,
            participantIds,
            subjectId: sessionId,
            eventId: idempotencyKey,
            type: `${kind}_started`,
            title: copy.title,
            body: copy.body,
            route: `/LiveWalkViewer?sessionId=${sessionId}&collection=routes`,
            data: { sessionId, kind },
        })
        : [];
    return {
        sessionId,
        state: "active",
        participantIds,
        deliveries,
        sms_required: guardianIds.length === 0 ||
            deliveries.some((item) => item.sms_required),
    };
}
/** POST /safe-walk/start */
exports.startSafeWalk = (0, https_1.onCall)(async (request) => {
    const uid = requireAuth(request.auth?.uid);
    return createSafetySession(uid, "safe_walk", request.data ?? {});
});
exports.startLiveShare = (0, https_1.onCall)(async (request) => {
    const uid = requireAuth(request.auth?.uid);
    return createSafetySession(uid, "live_share", request.data ?? {});
});
const SAFETY_EVENTS = new Set([
    "started",
    "location",
    "checkin_requested",
    "checkin_ok",
    "checkin_failed",
    "guardian_acknowledged",
    "arrived",
    "ended",
    "cancelled",
]);
/** After a session closes, participants keep read access this long (rules check readableUntil). */
const CLOSED_READ_GRACE_MS = 15 * 60_000;
const ROUTE_MAX_DURATION_MS = 8 * 60 * 60_000;
const SOS_MAX_DURATION_MS = 4 * 60 * 60_000;
const RESPONDER_ACCESS_MS = 60 * 60_000;
/** sos_responders/{emergencyId} = { userIds }. Server-only. */
const SOS_RESPONDERS = "sos_responders";
const OPEN_ROUTE_STATES = ["active", "check_in_pending", "sos"];
function closeFields() {
    return {
        closedAt: firestore_2.FieldValue.serverTimestamp(),
        readableUntil: firestore_2.Timestamp.fromMillis(Date.now() + CLOSED_READ_GRACE_MS),
    };
}
function stateForSafetyEvent(type, current) {
    if (type === "checkin_requested")
        return "check_in_pending";
    if (type === "checkin_failed")
        return "sos";
    if (type === "arrived" || type === "ended")
        return "completed";
    if (type === "cancelled")
        return "cancelled";
    if (type === "checkin_ok")
        return "active";
    return current;
}
async function publishSafetyEventInternal(uid, data) {
    const sessionId = requiredString(data.sessionId, "sessionId", 128);
    const id = eventId(data.eventId);
    const type = requiredString(data.type, "type", 64);
    if (!SAFETY_EVENTS.has(type) || type === "started") {
        throw new https_1.HttpsError("invalid-argument", "Unsupported safety event type.");
    }
    const location = validLocation(data.location);
    const ref = db.collection("routes").doc(sessionId);
    let participantIds = [];
    let ownerId = "";
    let kind = "safe_walk";
    let walkerName = "Someone you trust";
    let destinationLabel = null;
    let state = "active";
    let previousState = "active";
    const duplicate = await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        if (!snap.exists)
            throw new https_1.HttpsError("not-found", "Safety session not found.");
        participantIds = uniqueStrings(snap.get("participantIds"));
        ownerId = String(snap.get("ownerId") ?? snap.get("userId") ?? "");
        kind = String(snap.get("kind") ?? "safe_walk");
        walkerName = String(snap.get("walkerName") || walkerName);
        destinationLabel =
            typeof snap.get("destinationLabel") === "string" ? snap.get("destinationLabel") : null;
        if (!participantIds.includes(uid)) {
            throw new https_1.HttpsError("permission-denied", "You are not a session participant.");
        }
        if (uid !== ownerId && type !== "guardian_acknowledged") {
            throw new https_1.HttpsError("permission-denied", "Only the session owner can publish this event.");
        }
        const eventRef = ref.collection("events").doc(id);
        const existing = await transaction.get(eventRef);
        const currentState = String(snap.get("state") ?? "active");
        previousState = currentState;
        if (!existing.exists &&
            ["completed", "cancelled", "expired"].includes(currentState)) {
            throw new https_1.HttpsError("failed-precondition", "This safety session is already closed.");
        }
        state = stateForSafetyEvent(type, currentState);
        if (existing.exists)
            return true;
        const now = firestore_2.FieldValue.serverTimestamp();
        transaction.create(eventRef, {
            eventId: id,
            type,
            actorId: uid,
            location,
            etaMinutes: typeof data.etaMinutes === "number" ? Math.max(0, data.etaMinutes) : null,
            data: data.data && typeof data.data === "object" ? data.data : {},
            createdAt: now,
        });
        const etaMinutes = typeof data.etaMinutes === "number" && Number.isFinite(data.etaMinutes)
            ? Math.max(0, data.etaMinutes)
            : undefined;
        transaction.update(ref, {
            state,
            lastEventId: id,
            updatedAt: now,
            ...(etaMinutes !== undefined ? { etaMinutes } : {}),
            ...(OPEN_ROUTE_STATES.includes(state) ? {} : closeFields()),
        });
        transaction.set(ref.collection("live").doc("current"), {
            ownerId,
            participantIds,
            state,
            eventId: id,
            ...(location ? { location } : {}),
            updatedAt: now,
        }, { merge: true });
        return false;
    });
    // checkin_ok is routine, except as the all-clear after guardians were alerted.
    const allClear = type === "checkin_ok" && previousState === "sos";
    const shouldNotify = !duplicate &&
        (allClear || !["location", "checkin_ok", "checkin_requested"].includes(type));
    let recipients = participantIds.filter((id) => id !== uid);
    if (type === "guardian_acknowledged") {
        recipients = recipients.filter((id) => id === ownerId);
    }
    const copy = sessionCopy(kind, type, walkerName, destinationLabel);
    const deliveries = shouldNotify
        ? await notifyParticipants({
            ownerId,
            participantIds: recipients,
            subjectId: sessionId,
            eventId: id,
            type: `safety_${type}`,
            title: copy.title,
            body: copy.body,
            // The owner can't open their own LiveWalkViewer; send them to their live session.
            route: type === "guardian_acknowledged"
                ? kind === "safe_walk"
                    ? "/(tabs)/safewalk"
                    : "/(tabs)/navigate"
                : `/LiveWalkViewer?sessionId=${sessionId}&collection=routes`,
            data: { sessionId, eventType: type, kind },
            includeOwner: true,
        })
        : [];
    return {
        sessionId,
        eventId: id,
        duplicate,
        state,
        deliveries,
        sms_required: deliveries.some((item) => item.sms_required),
    };
}
/**
 * A walker has one live session per kind. Starting a new one closes any older
 * open session (e.g. a walk whose screen was lost) so guardians aren't left
 * watching a stale walk.
 */
async function closeSupersededSessions(ownerId, kind, keepSessionId) {
    const open = await db
        .collection("routes")
        .where("userId", "==", ownerId)
        .where("state", "in", OPEN_ROUTE_STATES)
        .get();
    const stale = open.docs.filter((doc) => doc.id !== keepSessionId && String(doc.get("kind") ?? "safe_walk") === kind);
    await Promise.all(stale.map((doc) => publishSafetyEventInternal(ownerId, {
        sessionId: doc.id,
        type: "ended",
        eventId: `${doc.id}-superseded`,
        data: { reason: "superseded", supersededBy: keepSessionId },
    }).catch((error) => console.warn(`Could not close ${doc.id}`, error))));
}
exports.publishSafetyEvent = (0, https_1.onCall)(async (request) => {
    const uid = requireAuth(request.auth?.uid);
    return publishSafetyEventInternal(uid, request.data ?? {});
});
/**
 * Server-side arrival so guardians hear "arrived safely" even when the walker's
 * app is backgrounded. Foreground clients publish their own arrival event.
 */
exports.onLiveRouteLocationUpdated = (0, firestore_1.onDocumentWritten)({ document: "routes/{routeId}/live/current", region: FIRESTORE_REGION }, async (event) => {
    const live = event.data?.after.data();
    const location = live?.location;
    if (typeof location?.latitude !== "number" ||
        typeof location?.longitude !== "number" ||
        live?.source !== "background" ||
        !["active", "check_in_pending"].includes(String(live?.state ?? "active"))) {
        return;
    }
    const route = await db.collection("routes").doc(event.params.routeId).get();
    if (!route.exists || route.get("state") !== "active")
        return;
    const destination = route.get("destination");
    if (typeof destination?.latitude !== "number" ||
        typeof destination?.longitude !== "number") {
        return;
    }
    const walking = route.get("kind") === "safe_walk" || route.get("travelMode") === "walking";
    if ((0, routeOptimization_1.haversineM)(location, destination) > (walking ? 50 : 80))
        return;
    try {
        await publishSafetyEventInternal(String(route.get("ownerId")), {
            sessionId: event.params.routeId,
            eventId: `arrival-${event.params.routeId}`,
            type: "arrived",
            location,
        });
    }
    catch (error) {
        if (!(error instanceof https_1.HttpsError && error.code === "failed-precondition"))
            throw error;
    }
});
exports.publishSafeWalkEvent = exports.publishSafetyEvent;
exports.publishLiveShareEvent = exports.publishSafetyEvent;
/** Compatibility endpoint for the original boolean check-in contract. */
exports.safeWalkCheckin = (0, https_1.onCall)(async (request) => {
    const uid = requireAuth(request.auth?.uid);
    const data = (request.data ?? {});
    const ok = data.ok === true;
    const result = await publishSafetyEventInternal(uid, {
        sessionId: data.sessionId,
        eventId: data.eventId ?? (0, node_crypto_1.randomUUID)(),
        type: ok ? "checkin_ok" : "checkin_failed",
        location: data.location,
    });
    return { ...result, state: ok ? "active" : "sos" };
});
const NEARBY_RADIUS_M = 300;
const NEARBY_FRESH_MS = 30 * 60_000;
const NEARBY_MAX_HELPERS = 15;
const NEARBY_BROADCASTS_PER_HOUR = 3;
function distanceM(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.latitude - a.latitude) * rad;
    const dLng = (b.longitude - a.longitude) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}
/** Opted-in users whose app reported a location within NEARBY_RADIUS_M recently. */
async function findNearbyHelpers(center, exclude) {
    // geohash6 cells are ~1.2 km × 0.6 km, so a 3×3 sample at the radius covers the circle.
    const dLat = NEARBY_RADIUS_M / 111_320;
    const dLng = NEARBY_RADIUS_M / (111_320 * Math.cos((center.latitude * Math.PI) / 180));
    const cells = new Set();
    for (const i of [-1, 0, 1]) {
        for (const j of [-1, 0, 1]) {
            cells.add((0, geohash_1.encodeGeohash)(center.latitude + i * dLat, center.longitude + j * dLng, 6));
        }
    }
    const snap = await db.collection("presence").where("geohash6", "in", [...cells]).get();
    const cutoff = Date.now() - NEARBY_FRESH_MS;
    const excluded = new Set(exclude);
    return snap.docs
        .map((doc) => ({
        userId: String(doc.get("userId") ?? doc.id),
        latitude: Number(doc.get("latitude")),
        longitude: Number(doc.get("longitude")),
        updatedAtMs: Number(doc.get("updatedAtMs") ?? 0),
    }))
        .filter((p) => !excluded.has(p.userId) &&
        p.updatedAtMs >= cutoff &&
        Number.isFinite(p.latitude) &&
        Number.isFinite(p.longitude))
        .map((p) => ({ userId: p.userId, distanceM: distanceM(center, p) }))
        .filter((p) => p.distanceM <= NEARBY_RADIUS_M)
        .sort((a, b) => a.distanceM - b.distanceM)
        .slice(0, NEARBY_MAX_HELPERS);
}
/** Caps how often one account can broadcast an SOS to strangers. */
async function claimNearbyBroadcast(uid) {
    // sos_limits has no client rules, so only the server can read or reset it.
    const ref = db.collection("sos_limits").doc(uid);
    return db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        const hourAgo = Date.now() - 60 * 60_000;
        const recent = (Array.isArray(snap.get("nearbySosAtMs")) ? snap.get("nearbySosAtMs") : [])
            .filter((t) => typeof t === "number" && t > hourAgo);
        if (recent.length >= NEARBY_BROADCASTS_PER_HOUR)
            return false;
        transaction.set(ref, { nearbySosAtMs: [...recent, Date.now()] }, { merge: true });
        return true;
    });
}
async function alertNearbyHelpers(input) {
    const helpers = await findNearbyHelpers(input.location, input.exclude);
    if (helpers.length === 0 || !(await claimNearbyBroadcast(input.ownerId)))
        return 0;
    const ref = db.collection("emergencies").doc(input.emergencyId);
    // Kept off the emergency doc so the SOS owner can't learn who was nearby.
    await db.collection(SOS_RESPONDERS).doc(input.emergencyId).set({
        userIds: helpers.map((h) => h.userId),
        createdAt: firestore_2.FieldValue.serverTimestamp(),
    });
    await ref.update({
        responderAccessUntil: firestore_2.Timestamp.fromMillis(Date.now() + RESPONDER_ACCESS_MS),
    });
    await Promise.all(helpers.map((helper) => createAndDispatchNotification({
        userId: helper.userId,
        fromUserId: input.ownerId,
        subjectId: input.emergencyId,
        eventId: `${input.eventId}-nearby`,
        type: "sos_nearby",
        title: "Someone nearby needs help",
        body: `A SafeRoute user about ${Math.max(10, Math.round(helper.distanceM / 10) * 10)} m from you triggered SOS. Tap to see where they are.`,
        route: `/LiveWalkViewer?sessionId=${input.emergencyId}&collection=emergencies&role=responder`,
        data: { emergencyId: input.emergencyId, eventType: "nearby" },
    })));
    return helpers.length;
}
/** POST /sos */
exports.activateSOS = (0, https_1.onCall)(async (request) => {
    const uid = requireAuth(request.auth?.uid);
    const data = (request.data ?? {});
    const id = data.eventId == null ? (0, node_crypto_1.randomUUID)() : eventId(data.eventId);
    const location = validLocation({
        latitude: data.latitude,
        longitude: data.longitude,
        accuracyM: data.accuracyM,
        recordedAtMs: Date.now(),
    });
    if (!location)
        throw new https_1.HttpsError("invalid-argument", "Location is required.");
    const requested = uniqueStrings(data.guardianUserIds);
    const guardianIds = await acceptedGuardianIds(uid, requested);
    const participantIds = [uid, ...guardianIds];
    const walkerName = optionalString(data.walkerName, 100) ||
        optionalString((await db.collection("users").doc(uid).get()).get("displayName"), 100);
    const emergencyId = documentId("sos", uid, id);
    const ref = db.collection("emergencies").doc(emergencyId);
    const duplicate = await db.runTransaction(async (transaction) => {
        const existing = await transaction.get(ref);
        if (existing.exists)
            return true;
        const now = firestore_2.FieldValue.serverTimestamp();
        transaction.create(ref, {
            userId: uid,
            ownerId: uid,
            guardianUserIds: guardianIds,
            participantIds,
            walkerName,
            latitude: location.latitude,
            longitude: location.longitude,
            location,
            geohash: (0, geohash_1.encodeGeohash)(location.latitude, location.longitude, 7),
            silent: data.silent === true,
            batteryPct: typeof data.batteryPct === "number" ? data.batteryPct : null,
            networkType: optionalString(data.networkType, 50),
            audioPath: optionalString(data.audioPath, 500),
            snapshotPath: optionalString(data.snapshotPath, 500),
            safeWalkId: optionalString(data.safeWalkId, 128),
            state: "active",
            eventId: id,
            lastEventId: id,
            createdAt: now,
            updatedAt: now,
            nextGpsAt: firestore_2.Timestamp.fromMillis(Date.now() + 5000),
        });
        transaction.create(ref.collection("events").doc(id), {
            eventId: id,
            type: "activated",
            actorId: uid,
            location,
            createdAt: now,
        });
        transaction.set(ref.collection("live").doc("current"), {
            ownerId: uid,
            participantIds,
            state: "active",
            eventId: id,
            location,
            updatedAt: now,
        });
        return false;
    });
    const [deliveries] = duplicate
        ? [[]]
        : await Promise.all([
            notifyParticipants({
                ownerId: uid,
                participantIds,
                subjectId: emergencyId,
                eventId: id,
                type: "sos_activated",
                title: walkerName ? `SOS from ${walkerName}` : "SOS alert",
                body: `${walkerName || "Someone who trusts you"} needs help. Tap to see their live location.`,
                route: `/LiveWalkViewer?sessionId=${emergencyId}&collection=emergencies`,
                data: { emergencyId, eventType: "activated" },
            }),
            alertNearbyHelpers({
                ownerId: uid,
                emergencyId,
                eventId: id,
                location,
                exclude: participantIds,
            }).catch((error) => {
                console.warn("Nearby helper alert failed", error);
                return 0;
            }),
        ]);
    const smsRequired = data.networkType === "none" ||
        guardianIds.length === 0 ||
        deliveries.some((item) => item.sms_required);
    return {
        emergencyId,
        eventId: id,
        duplicate,
        // Nearby results stay server-side: even a yes/no would let a caller probe
        // whether anyone is around a point.
        deliveries,
        sms_required: smsRequired,
        smsFallback: smsRequired,
    };
});
const EMERGENCY_EVENTS = new Set([
    "activated",
    "location",
    "guardian_acknowledged",
    "resolved",
    "cancelled",
]);
exports.publishEmergencyEvent = (0, https_1.onCall)(async (request) => {
    const uid = requireAuth(request.auth?.uid);
    const data = (request.data ?? {});
    const emergencyId = requiredString(data.emergencyId, "emergencyId", 128);
    const id = eventId(data.eventId);
    const type = requiredString(data.type, "type", 64);
    if (!EMERGENCY_EVENTS.has(type) || type === "activated") {
        throw new https_1.HttpsError("invalid-argument", "Unsupported emergency event type.");
    }
    const location = validLocation(data.location);
    const ref = db.collection("emergencies").doc(emergencyId);
    let participantIds = [];
    const responderIds = uniqueStrings((await db.collection(SOS_RESPONDERS).doc(emergencyId).get()).get("userIds"));
    let ownerId = "";
    let state = "active";
    const duplicate = await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        if (!snap.exists)
            throw new https_1.HttpsError("not-found", "Emergency not found.");
        participantIds = uniqueStrings(snap.get("participantIds"));
        ownerId = String(snap.get("ownerId") ?? snap.get("userId") ?? "");
        const accessUntil = snap.get("responderAccessUntil");
        const isResponder = responderIds.includes(uid) &&
            type === "guardian_acknowledged" &&
            accessUntil instanceof firestore_2.Timestamp &&
            accessUntil.toMillis() > Date.now();
        if (!participantIds.includes(uid) && !isResponder) {
            throw new https_1.HttpsError("permission-denied", "You are not an emergency participant.");
        }
        if (uid !== ownerId && type !== "guardian_acknowledged") {
            throw new https_1.HttpsError("permission-denied", "Only the owner can publish this event.");
        }
        const eventRef = ref.collection("events").doc(id);
        const existing = await transaction.get(eventRef);
        if (!existing.exists &&
            ["resolved", "cancelled", "expired"].includes(String(snap.get("state") ?? "active"))) {
            throw new https_1.HttpsError("failed-precondition", "This emergency session is already closed.");
        }
        if (existing.exists)
            return true;
        state = type === "resolved" ? "resolved" : type === "cancelled" ? "cancelled" : "active";
        const now = firestore_2.FieldValue.serverTimestamp();
        transaction.create(eventRef, {
            eventId: id,
            type,
            actorId: uid,
            location,
            data: data.data && typeof data.data === "object" ? data.data : {},
            createdAt: now,
        });
        transaction.update(ref, {
            state,
            lastEventId: id,
            updatedAt: now,
            ...(state === "active" ? {} : closeFields()),
        });
        transaction.set(ref.collection("live").doc("current"), {
            ownerId,
            participantIds,
            state,
            eventId: id,
            ...(location ? { location } : {}),
            updatedAt: now,
        }, { merge: true });
        return false;
    });
    const shouldNotify = !duplicate && type !== "location";
    const sosCopy = {
        resolved: { title: "SOS resolved", body: "The emergency has been marked resolved. They are safe." },
        cancelled: { title: "SOS cancelled", body: "The SOS was cancelled by the sender." },
        guardian_acknowledged: {
            title: "A guardian is responding",
            body: "One of your guardians has seen your SOS and is watching your live location.",
        },
    };
    const actorIsResponder = !participantIds.includes(uid) && responderIds.includes(uid);
    const copy = type === "guardian_acknowledged" && actorIsResponder
        ? {
            title: "Someone nearby is coming",
            body: "A SafeRoute user near you saw your SOS and is on their way to help.",
        }
        : sosCopy[type] ?? {
            title: "SOS update",
            body: "Open SafeRoute for the latest emergency update.",
        };
    if (shouldNotify && (type === "resolved" || type === "cancelled") && responderIds.length) {
        await Promise.all(responderIds
            .filter((responder) => responder !== uid)
            .map((responder) => createAndDispatchNotification({
            userId: responder,
            fromUserId: ownerId,
            subjectId: emergencyId,
            eventId: id,
            type: `sos_nearby_${type}`,
            title: type === "resolved" ? "Nearby SOS resolved" : "Nearby SOS cancelled",
            body: type === "resolved"
                ? "The person is safe now. Thank you for being ready to help."
                : "The SOS was cancelled. No need to go.",
            route: "/(tabs)/alerts",
            data: { emergencyId, eventType: type },
        }))).catch((error) => console.warn("Responder close-out push failed", error));
    }
    const deliveries = shouldNotify
        ? await notifyParticipants({
            ownerId,
            participantIds: type === "guardian_acknowledged"
                ? [ownerId]
                : participantIds.filter((participant) => participant !== uid),
            subjectId: emergencyId,
            eventId: id,
            type: `sos_${type}`,
            title: copy.title,
            body: copy.body,
            route: type === "guardian_acknowledged"
                ? "/(tabs)/SOS"
                : `/LiveWalkViewer?sessionId=${emergencyId}&collection=emergencies`,
            data: { emergencyId, eventType: type },
            includeOwner: uid !== ownerId,
        })
        : [];
    return {
        emergencyId,
        eventId: id,
        duplicate,
        state,
        deliveries,
        sms_required: deliveries.some((item) => item.sms_required),
    };
});
exports.markNotificationRead = (0, https_1.onCall)(async (request) => {
    const uid = requireAuth(request.auth?.uid);
    const notificationId = requiredString(request.data?.notificationId, "notificationId", 128);
    const ref = db.collection("notifications").doc(notificationId);
    const readAt = firestore_2.Timestamp.now();
    await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        if (!snap.exists)
            throw new https_1.HttpsError("not-found", "Notification not found.");
        if (snap.get("userId") !== uid) {
            throw new https_1.HttpsError("permission-denied", "This notification is not yours.");
        }
        if (!snap.get("readAt"))
            transaction.update(ref, { readAt });
    });
    return { notificationId, readAtMs: readAt.toMillis() };
});
/** Deletes all of the caller's notifications (the Alerts tab "Clear all"). */
exports.clearNotifications = (0, https_1.onCall)(async (request) => {
    const uid = requireAuth(request.auth?.uid);
    let deleted = 0;
    for (;;) {
        const page = await db
            .collection("notifications")
            .where("userId", "==", uid)
            .limit(400)
            .get();
        if (page.empty)
            break;
        const batch = db.batch();
        page.docs.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
        deleted += page.size;
        if (page.size < 400)
            break;
    }
    return { deleted };
});
/** Compatibility helper retained for existing server imports. */
async function sendGuardianNotification(userId, guardianUserId, subjectId, title) {
    return createAndDispatchNotification({
        userId: guardianUserId,
        fromUserId: userId,
        subjectId,
        title,
        body: "Open SafeRoute to respond.",
        type: "guardian_alert",
        route: "/(tabs)/alerts",
        data: { subjectId },
    });
}
/** Anonymous count. Document id is geohash + minute bucket. No user id is stored. */
exports.updateCrowdDensity = (0, https_1.onRequest)(async (req, res) => {
    if (req.method !== "POST") {
        res.status(405).send("POST only");
        return;
    }
    const { geohash, bucketStartMs } = req.body;
    if (!geohash || geohash.length < 7 || !bucketStartMs) {
        res.status(400).send("geohash and bucketStartMs are required");
        return;
    }
    const id = `${geohash}_${bucketStartMs}`;
    await db
        .collection("crowd_cells")
        .doc(id)
        .set({
        geohash: geohash.slice(0, 7),
        bucketStartMs,
        count: firestore_2.FieldValue.increment(1),
        expiresAt: firestore_2.Timestamp.fromMillis(bucketStartMs + 15 * 60 * 1000),
    }, { merge: true });
    res.status(204).send("");
});
/** Hourly. Reports older than 180 days are marked expired. */
exports.expireOldReports = (0, scheduler_1.onSchedule)("every 60 minutes", async () => {
    const cutoff = firestore_2.Timestamp.fromMillis(Date.now() - 180 * 24 * 60 * 60 * 1000);
    const stale = await db
        .collection("reports")
        .where("createdAt", "<", cutoff)
        .limit(200)
        .get();
    const batch = db.batch();
    stale.docs.forEach((doc) => {
        batch.update(doc.ref, { status: "expired" });
        batch.set(db.collection(REPORT_AUTHORS).doc(doc.id), { status: "expired" }, { merge: true });
    });
    await batch.commit();
});
exports.expireStaleSafetySessions = (0, scheduler_1.onSchedule)("every 60 minutes", async () => {
    // Location fixes only touch live/current, so a session is stale when both
    // the parent doc and its latest fix are older than the idle window.
    const idleMs = 2 * 60 * 60 * 1000;
    const nowMs = Date.now();
    const cutoff = firestore_2.Timestamp.fromMillis(nowMs - idleMs);
    const [idleRoutes, idleEmergencies, oldRoutes, oldEmergencies] = await Promise.all([
        db.collection("routes").where("state", "in", OPEN_ROUTE_STATES)
            .where("updatedAt", "<", cutoff).limit(200).get(),
        db.collection("emergencies").where("state", "==", "active")
            .where("updatedAt", "<", cutoff).limit(200).get(),
        // Hard caps: sharing ends even if the phone keeps sending fixes.
        db.collection("routes").where("state", "in", OPEN_ROUTE_STATES)
            .where("createdAt", "<", firestore_2.Timestamp.fromMillis(nowMs - ROUTE_MAX_DURATION_MS))
            .limit(200).get(),
        db.collection("emergencies").where("state", "==", "active")
            .where("createdAt", "<", firestore_2.Timestamp.fromMillis(nowMs - SOS_MAX_DURATION_MS))
            .limit(200).get(),
    ]);
    const forced = new Set([...oldRoutes.docs, ...oldEmergencies.docs].map((d) => d.ref.path));
    const byPath = new Map();
    [...idleRoutes.docs, ...idleEmergencies.docs, ...oldRoutes.docs, ...oldEmergencies.docs]
        .forEach((d) => byPath.set(d.ref.path, d));
    const candidates = [...byPath.values()];
    const lives = await Promise.all(candidates.map((item) => item.ref.collection("live").doc("current").get()));
    const toExpire = candidates.filter((item, i) => {
        if (forced.has(item.ref.path))
            return true;
        const liveUpdated = lives[i].get("updatedAt");
        return !(liveUpdated instanceof firestore_2.Timestamp && liveUpdated.toMillis() > cutoff.toMillis());
    });
    for (let start = 0; start < toExpire.length; start += 200) {
        const batch = db.batch();
        toExpire.slice(start, start + 200).forEach((item) => {
            const now = firestore_2.FieldValue.serverTimestamp();
            batch.update(item.ref, { state: "expired", updatedAt: now, ...closeFields() });
            // set+merge so a missing live doc doesn't fail the batch.
            batch.set(item.ref.collection("live").doc("current"), { state: "expired", updatedAt: now }, { merge: true });
        });
        await batch.commit();
    }
});
