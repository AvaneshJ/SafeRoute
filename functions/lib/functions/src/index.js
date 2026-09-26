"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.expireStaleSafetySessions = exports.expireOldReports = exports.updateCrowdDensity = exports.markNotificationRead = exports.publishEmergencyEvent = exports.activateSOS = exports.safeWalkCheckin = exports.publishLiveShareEvent = exports.publishSafeWalkEvent = exports.onLiveRouteLocationUpdated = exports.publishSafetyEvent = exports.startLiveShare = exports.startSafeWalk = exports.revokeGuardian = exports.acceptGuardianInvite = exports.inviteGuardian = exports.createGuardianInvite = exports.moderateReport = exports.onReportCreated = exports.verifyReport = exports.generateRoutes = exports.calculateSafetyScore = void 0;
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
        .collection("reports")
        .where("authorIdPrivate", "==", uid)
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
    const ref = await db.collection("reports").add({
        authorId: data.anonymous ? null : uid,
        authorIdPrivate: uid,
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
exports.onReportCreated = (0, firestore_1.onDocumentCreated)("reports/{reportId}", async (event) => {
    const report = event.data?.data();
    const userId = report?.authorIdPrivate;
    if (!report || typeof userId !== "string")
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
    if (status === "verified") {
        await aggregateCommunityCell({ ...prev, status: "verified" });
        await db.collection("trust_logs").add({
            userId: prev.authorIdPrivate,
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
    const requested = [...new Set(requestedIds)];
    if (requested.some((id) => !accepted.has(id))) {
        throw new https_1.HttpsError("failed-precondition", "Every participant must be an accepted guardian.");
    }
    return requested;
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
        if (tickets.some((ticket) => ticket.status === "ok")) {
            return { status: "sent", ticketIds };
        }
        const invalid = tickets.length > 0 && tickets.every((ticket) => ticket.details?.error === "DeviceNotRegistered");
        return {
            status: invalid ? "invalid_push_token" : "failed",
            ticketIds,
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
        route: input.route,
        notificationId: id,
    });
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
        return {
            inviteId: ref.id,
            inviteToken,
            status: "pending",
            expiresAtMs,
            delivery: null,
            sms_required: true,
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
    if (!guardianUserId) {
        const field = email ? "email" : "phoneNumber";
        const value = email ?? phone;
        const match = await db.collection("users").where(field, "==", value).limit(1).get();
        guardianUserId = match.empty ? null : match.docs[0].id;
    }
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
    await ref.set({
        userId: uid,
        ownerId: uid,
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
        ? await createAndDispatchNotification({
            userId: guardianUserId,
            fromUserId: uid,
            subjectId: ref.id,
            eventId: ref.id,
            type: "guardian_invite",
            title: "Guardian invitation",
            body: "Someone invited you to be their SafeRoute guardian.",
            route: "/(tabs)/contacts",
            data: { inviteId: ref.id },
        })
        : null;
    return {
        inviteId: ref.id,
        inviteToken,
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
        body: "Your guardian accepted the SafeRoute invitation.",
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
        const active = [...routes.docs, ...emergencies.docs].filter((doc) => !["completed", "cancelled", "resolved"].includes(String(doc.get("state"))));
        const batch = db.batch();
        active.forEach((doc) => {
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
        if (active.length > 0)
            await batch.commit();
    }
    return { guardianId, status: "revoked" };
});
async function createSafetySession(ownerId, kind, data) {
    const requested = uniqueStrings(data.guardianUserIds ?? (data.guardianUserId ? [data.guardianUserId] : []));
    const hasExplicitGuardians = Array.isArray(data.guardianUserIds) || data.guardianUserId != null;
    const guardianIds = hasExplicitGuardians && requested.length === 0
        ? []
        : await acceptedGuardianIds(ownerId, requested);
    const idempotencyKey = data.eventId == null ? (0, node_crypto_1.randomUUID)() : eventId(data.eventId);
    const sessionId = documentId(kind, ownerId, idempotencyKey);
    const ref = db.collection("routes").doc(sessionId);
    const location = kind === "live_share" ? validLocation(data.location) : null;
    const destination = kind === "safe_walk" ? validLocation(data.destination) : null;
    if (kind === "safe_walk" && !destination) {
        throw new https_1.HttpsError("invalid-argument", "destination is required.");
    }
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
            guardianUserId: guardianIds[0],
            guardianUserIds: guardianIds,
            participantIds,
            walkerName,
            destination,
            destinationLabel: optionalString(data.destinationLabel, 200),
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
    const deliveries = created
        ? await notifyParticipants({
            ownerId,
            participantIds,
            subjectId: sessionId,
            eventId: idempotencyKey,
            type: `${kind}_started`,
            title: kind === "safe_walk" ? "Safe Walk started" : "Live location shared",
            body: kind === "safe_walk"
                ? `${walkerName} started a Safe Walk. Tap to follow their live location.`
                : `${walkerName} shared a live location with you.`,
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
    let state = "active";
    const duplicate = await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        if (!snap.exists)
            throw new https_1.HttpsError("not-found", "Safety session not found.");
        participantIds = uniqueStrings(snap.get("participantIds"));
        ownerId = String(snap.get("ownerId") ?? snap.get("userId") ?? "");
        if (!participantIds.includes(uid)) {
            throw new https_1.HttpsError("permission-denied", "You are not a session participant.");
        }
        if (uid !== ownerId && type !== "guardian_acknowledged") {
            throw new https_1.HttpsError("permission-denied", "Only the session owner can publish this event.");
        }
        const eventRef = ref.collection("events").doc(id);
        const existing = await transaction.get(eventRef);
        const currentState = String(snap.get("state") ?? "active");
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
        transaction.update(ref, { state, lastEventId: id, updatedAt: now });
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
    const shouldNotify = !duplicate && !["location", "checkin_ok"].includes(type);
    const ownerProfile = await db.collection("users").doc(ownerId).get();
    const walkerName = optionalString(ownerProfile.get("displayName"), 100) ||
        "Someone you trust";
    const deliveries = shouldNotify
        ? await notifyParticipants({
            ownerId,
            participantIds,
            subjectId: sessionId,
            eventId: id,
            type: `safety_${type}`,
            title: type === "checkin_failed" ? "Safety check-in missed" : "Safe Walk update",
            body: type === "arrived"
                ? `${walkerName} arrived safely.`
                : "Open SafeRoute for the latest safety update.",
            route: `/LiveWalkViewer?sessionId=${sessionId}&collection=routes`,
            data: { sessionId, eventType: type },
            includeOwner: uid !== ownerId,
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
exports.publishSafetyEvent = (0, https_1.onCall)(async (request) => {
    const uid = requireAuth(request.auth?.uid);
    return publishSafetyEventInternal(uid, request.data ?? {});
});
exports.onLiveRouteLocationUpdated = (0, firestore_1.onDocumentWritten)("routes/{routeId}/live/current", async (event) => {
    const live = event.data?.after.data();
    const location = live?.location;
    if (typeof location?.latitude !== "number" ||
        typeof location?.longitude !== "number" ||
        live?.source !== "background") {
        return;
    }
    const route = await db.collection("routes").doc(event.params.routeId).get();
    if (!route.exists ||
        route.get("kind") !== "safe_walk" ||
        route.get("state") !== "active") {
        return;
    }
    const destination = route.get("destination");
    if (typeof destination?.latitude !== "number" ||
        typeof destination?.longitude !== "number" ||
        (0, routeOptimization_1.haversineM)(location, destination) > 50) {
        return;
    }
    await publishSafetyEventInternal(String(route.get("ownerId")), {
        sessionId: event.params.routeId,
        eventId: `arrival-${event.params.routeId}`,
        type: "arrived",
        location,
    });
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
    const deliveries = duplicate
        ? []
        : await notifyParticipants({
            ownerId: uid,
            participantIds,
            subjectId: emergencyId,
            eventId: id,
            type: "sos_activated",
            title: "SOS alert",
            body: "A person who trusts you needs help. Open SafeRoute now.",
            route: `/LiveWalkViewer?sessionId=${emergencyId}&collection=emergencies`,
            data: { emergencyId, eventType: "activated" },
        });
    const smsRequired = data.networkType === "none" ||
        guardianIds.length === 0 ||
        deliveries.some((item) => item.sms_required);
    return {
        emergencyId,
        eventId: id,
        duplicate,
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
    let ownerId = "";
    let state = "active";
    const duplicate = await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        if (!snap.exists)
            throw new https_1.HttpsError("not-found", "Emergency not found.");
        participantIds = uniqueStrings(snap.get("participantIds"));
        ownerId = String(snap.get("ownerId") ?? snap.get("userId") ?? "");
        if (!participantIds.includes(uid)) {
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
        transaction.update(ref, { state, lastEventId: id, updatedAt: now });
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
    const deliveries = shouldNotify
        ? await notifyParticipants({
            ownerId,
            participantIds,
            subjectId: emergencyId,
            eventId: id,
            type: `sos_${type}`,
            title: type === "resolved" ? "SOS resolved" : "SOS update",
            body: type === "resolved"
                ? "The emergency has been marked resolved."
                : "Open SafeRoute for the latest emergency update.",
            route: `/LiveWalkViewer?sessionId=${emergencyId}&collection=emergencies`,
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
    stale.docs.forEach((doc) => batch.update(doc.ref, { status: "expired" }));
    await batch.commit();
});
exports.expireStaleSafetySessions = (0, scheduler_1.onSchedule)("every 60 minutes", async () => {
    const cutoff = firestore_2.Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);
    const [routes, emergencies] = await Promise.all([
        db
            .collection("routes")
            .where("state", "==", "active")
            .where("updatedAt", "<", cutoff)
            .limit(200)
            .get(),
        db
            .collection("emergencies")
            .where("state", "==", "active")
            .where("updatedAt", "<", cutoff)
            .limit(200)
            .get(),
    ]);
    const batch = db.batch();
    routes.docs.forEach((item) => batch.update(item.ref, {
        state: "expired",
        updatedAt: firestore_2.FieldValue.serverTimestamp(),
    }));
    emergencies.docs.forEach((item) => batch.update(item.ref, {
        state: "expired",
        updatedAt: firestore_2.FieldValue.serverTimestamp(),
    }));
    await batch.commit();
});
