"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GUARDIAN_INVITE_BASE_URL = void 0;
exports.guardianInviteUrl = guardianInviteUrl;
exports.downsamplePath = downsamplePath;
exports.safetyMapsLink = safetyMapsLink;
exports.safeWalkStartSms = safeWalkStartSms;
exports.safeWalkArrivalText = safeWalkArrivalText;
exports.GUARDIAN_INVITE_BASE_URL = "https://saferoute-8bc4f.web.app/invite";
function guardianInviteUrl(inviteId, token) {
    return `${exports.GUARDIAN_INVITE_BASE_URL}?inviteId=${encodeURIComponent(inviteId)}&token=${encodeURIComponent(token)}`;
}
/** Evenly thins a polyline, always keeping both endpoints. */
function downsamplePath(path, maxPoints) {
    const points = path.map(({ latitude, longitude }) => ({ latitude, longitude }));
    if (points.length <= maxPoints || maxPoints < 2)
        return points;
    const step = (points.length - 1) / (maxPoints - 1);
    return Array.from({ length: maxPoints }, (_, i) => points[Math.round(i * step)]);
}
function safetyMapsLink(latitude, longitude) {
    return `https://maps.google.com/?q=${latitude},${longitude}`;
}
function safeWalkStartSms(input) {
    const who = input.walkerName?.trim() || "Someone you trust";
    return (`${who} started a Safe Walk. Last known location: ` +
        `${safetyMapsLink(input.latitude, input.longitude)}. You'll receive another ` +
        `message on arrival or if a safety check-in fails.`);
}
function safeWalkArrivalText(walkerName) {
    return `${walkerName?.trim() || "Someone you trust"} arrived safely.`;
}
