import type { RtcProviderId } from "./rtcProviderCatalog";

export const roomRouteLeaseMs = 120_000;

export type RoomRoute = {
  provider: RtcProviderId;
  id: string;
  expiresAt: number;
  members: Record<string, number>;
};

export type RoomRouteRequest = {
  subject: string;
  eligible: RtcProviderId[];
  acceptingNewRooms: RtcProviderId[];
  excluded: RtcProviderId[];
  legacyProvider?: RtcProviderId;
  legacyMembers?: Record<string, number>;
  connectionAware?: boolean;
};

export type RoomRouteDecision = {
  route: RoomRoute | null;
  selected: RtcProviderId | null;
  locked: boolean;
};

/** Run inside one Durable Object storage transaction, never on eventually consistent KV. */
export function decideRoomRoute(
  stored: RoomRoute | undefined,
  request: RoomRouteRequest,
  now: number,
  nextId: string,
): RoomRouteDecision {
  let route = stored && stored.expiresAt > now ? {
    ...stored,
    members: Object.fromEntries(Object.entries(stored.members).filter(([, expiry]) => expiry > now)),
  } : null;
  if (!route && !request.legacyProvider && Object.values(request.legacyMembers || {}).some((expiry) => expiry > now)) {
    return { route: null, selected: null, locked: true };
  }
  if (!route && request.legacyProvider && Object.values(request.legacyMembers || {}).some((expiry) => expiry > now)) {
    route = {
      provider: request.legacyProvider,
      id: nextId,
      expiresAt: now + roomRouteLeaseMs,
      members: Object.fromEntries(Object.entries(request.legacyMembers || {}).filter(([, expiry]) => expiry > now)),
    };
  }
  const excluded = new Set(request.excluded);
  // This participant has abandoned the failed transport. Other participants'
  // claims remain authoritative, including joins that are still in progress.
  if (route && excluded.has(route.provider)) delete route.members[request.subject];
  const eligible = new Set(request.eligible.filter((provider) => !excluded.has(provider)));
  const othersPresent = route && Object.keys(route.members).some((subject) => subject !== request.subject);
  if (route && othersPresent && !eligible.has(route.provider)) {
    return { route, selected: null, locked: true };
  }
  let selected = route && eligible.has(route.provider) ? route.provider : null;
  if (!selected) selected = request.acceptingNewRooms.find((provider) => eligible.has(provider)) || null;
  if (!selected) return { route, selected: null, locked: false };
  if (!route || route.provider !== selected) {
    route = { provider: selected, id: nextId, expiresAt: now + roomRouteLeaseMs, members: {} };
  }
  const pendingLeaseMs = request.connectionAware ? 45_000 : roomRouteLeaseMs;
  route.members[request.subject] = Math.max(route.members[request.subject] || 0, now + pendingLeaseMs);
  route.expiresAt = Math.max(...Object.values(route.members));
  return { route, selected, locked: false };
}

export function updateRoomRouteMember(
  stored: RoomRoute | undefined,
  provider: RtcProviderId,
  subject: string,
  leaving: boolean,
  now: number,
  routeId?: string,
): { route: RoomRoute | undefined; accepted: boolean } {
  if (!stored || stored.provider !== provider || (routeId && stored.id !== routeId)) return { route: stored, accepted: false };
  if (!leaving && !stored.members[subject]) return { route: stored, accepted: false };
  const route = { ...stored, members: { ...stored.members } };
  if (leaving) delete route.members[subject];
  else {
    route.members[subject] = now + roomRouteLeaseMs;
    route.expiresAt = now + roomRouteLeaseMs;
  }
  return { route, accepted: true };
}
