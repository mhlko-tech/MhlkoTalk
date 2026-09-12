import assert from "node:assert/strict";
import { build } from "esbuild";
import type { IAgoraRTC } from "agora-rtc-sdk-ng";
import type { RtcProviderId } from "../src/core/rtcProviders";
import { routingForRtcProvider } from "../src/core/serviceRouting";
import { AgoraRtcSession } from "../src/services/agoraRtcSession";
import type { RoomConnectionCredentials } from "../src/services/rtcAdapterRegistry";
import {
  connectWithRtcFailover,
  isRetryableRtcConnectionFailure,
  RtcConnectionError,
  throwIfRtcJoinAborted,
  waitForRtcRoomRecovery,
  terminalRtcDisconnection,
} from "../src/services/rtcConnectionResilience";

const providers: RtcProviderId[] = ["agora", "livekit", "tencent"];
const credentials = (provider: RtcProviderId) => ({
  token: "opaque-token", identity: "me", roomName: "room",
  usageAccessToken: `usage-${provider}`,
  routing: { rtc: { provider, clientKey: "test-app" } },
}) as RoomConnectionCredentials;
const gatewayFailure = new Error("AgoraRTCError CAN_NOT_GET_GATEWAY_SERVER: flag 4096");
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

for (const failure of [gatewayFailure, new Error("ICE_FAILED"), new Error("Connection timed out"), { status: 503 }, new TypeError("Failed to fetch")]) {
  assert.equal(isRetryableRtcConnectionFailure(failure), true);
}
for (const failure of [
  new DOMException("Permission denied", "NotAllowedError"),
  new DOMException("No device", "NotFoundError"),
  new DOMException("Busy device", "NotReadableError"),
  new Error("INVALID_TOKEN"), new Error("Agora App ID is missing"), new Error("unexpected bug"),
  new RtcConnectionError("Connection auth failed", "AUTH_ERROR", 401),
  new RtcConnectionError("Connection forbidden", "AUTH_ERROR", 403),
]) assert.equal(isRetryableRtcConnectionFailure(failure), false);
for (const reason of ["TOKEN_EXPIRE", "UID_BANNED", "IP_BANNED", "CHANNEL_BANNED", "UID_CONFLICT", "LEAVE"]) {
  assert.equal(isRetryableRtcConnectionFailure(terminalRtcDisconnection("agora", reason)), false);
}
for (const reason of ["kick", "banned", "room_disband"]) {
  assert.equal(isRetryableRtcConnectionFailure(terminalRtcDisconnection("tencent", reason)), false);
}
assert.equal(terminalRtcDisconnection("agora", "NETWORK_ERROR"), null);
assert.equal(terminalRtcDisconnection("agora", "LICENSE_MINUTES_EXCEEDED"), null);
for (const reason of ["PARTICIPANT_REMOVED", "DUPLICATE_IDENTITY", "ROOM_DELETED", "CLIENT_INITIATED"]) {
  assert.equal(isRetryableRtcConnectionFailure(terminalRtcDisconnection("livekit", reason)), false);
}
assert.equal(terminalRtcDisconnection("livekit", "SIGNAL_CLOSE"), null);
assert.equal(terminalRtcDisconnection("livekit", "SERVER_SHUTDOWN"), null);

{
  const requests: RtcProviderId[][] = [], connected: RtcProviderId[] = [], cleaned: RtcProviderId[] = [];
  const result = await connectWithRtcFailover({
    supportedProviders: providers, signal: new AbortController().signal,
    async fetchCredentials(excluded) { requests.push(excluded); return credentials(excluded.length ? "livekit" : "agora"); },
    async connect(value) { connected.push(value.routing.rtc.provider); if (value.routing.rtc.provider === "agora") throw gatewayFailure; },
    async cleanup(value) { cleaned.push(value.routing.rtc.provider); },
  });
  assert.equal(result.routing.rtc.provider, "livekit");
  assert.deepEqual(requests, [[], ["agora"]]);
  assert.deepEqual(connected, ["agora", "livekit"]);
  assert.deepEqual(cleaned, ["agora"]);
}
{
  let requests = 0, cleaned = 0;
  await assert.rejects(connectWithRtcFailover({
    supportedProviders: providers, signal: new AbortController().signal,
    async fetchCredentials() { requests += 1; return credentials("agora"); },
    async connect() { throw new DOMException("Microphone denied", "NotAllowedError"); },
    async cleanup() { cleaned += 1; },
  }), { name: "NotAllowedError" });
  assert.equal(requests, 1);
  assert.equal(cleaned, 1, "Permission failures release the reserved route without trying unrelated providers");
}
{
  let connected = 0, requests = 0;
  await assert.rejects(connectWithRtcFailover({
    supportedProviders: providers, signal: new AbortController().signal,
    async fetchCredentials() { requests += 1; throw new RtcConnectionError("Room belongs to an active provider", "RTC_ROOM_PROVIDER_LOCKED", 409); },
    async connect() { connected += 1; }, async cleanup() {},
  }), { code: "RTC_ROOM_PROVIDER_LOCKED", status: 409 });
  assert.equal(requests, 1);
  assert.equal(connected, 0, "Initial room-lock errors must never create a split room");
}
{
  let connects = 0, cleanups = 0;
  await assert.rejects(connectWithRtcFailover({
    supportedProviders: providers, signal: new AbortController().signal,
    async fetchCredentials() { return credentials("agora"); },
    async connect() { connects += 1; throw gatewayFailure; }, async cleanup() { cleanups += 1; },
  }), { code: "RTC_INVALID_FALLBACK" });
  assert.equal(connects, 1, "A broker ignoring exclusions must not loop back to the failed provider");
  assert.equal(cleanups, 2);
}
{
  let attempts = 0;
  const requested: RtcProviderId[][] = [];
  await assert.rejects(connectWithRtcFailover({
    supportedProviders: providers, signal: new AbortController().signal,
    async fetchCredentials(excluded) { requested.push(excluded); return credentials(providers[excluded.length]); },
    async connect() { attempts += 1; throw gatewayFailure; }, async cleanup() {},
  }), /CAN_NOT_GET_GATEWAY_SERVER/);
  assert.equal(attempts, 3);
  assert.deepEqual(requested, [[], ["agora"], ["agora", "livekit"]]);
}
{
  const late = deferred<void>();
  let staleSuccesses = 0, abandonedSignal: AbortSignal | undefined;
  const result = await connectWithRtcFailover({
    supportedProviders: providers, signal: new AbortController().signal, timeoutMs: 8,
    async fetchCredentials(excluded) { return credentials(excluded.length ? "livekit" : "agora"); },
    async connect(value, signal) {
      if (value.routing.rtc.provider === "agora") {
        abandonedSignal = signal;
        await late.promise;
        throwIfRtcJoinAborted(signal);
        staleSuccesses += 1;
      }
    }, async cleanup() {},
  });
  assert.equal(result.routing.rtc.provider, "livekit");
  assert.equal(abandonedSignal?.aborted, true);
  late.resolve();
  await turn();
  assert.equal(staleSuccesses, 0, "An expired SDK join cannot replace its successful fallback");
}
{
  const controller = new AbortController(), entered = deferred<void>();
  let requests = 0, cleanups = 0;
  const operation = connectWithRtcFailover({
    supportedProviders: providers, signal: controller.signal,
    async fetchCredentials() { requests += 1; return credentials("agora"); },
    async connect() { entered.resolve(); return new Promise<void>(() => {}); },
    async cleanup() { cleanups += 1; },
  });
  const rejected = assert.rejects(operation, { name: "AbortError" });
  await entered.promise;
  controller.abort();
  await rejected;
  assert.equal(requests, 1);
  assert.equal(cleanups, 1);
}
{
  const controller = new AbortController(), token = deferred<RoomConnectionCredentials>();
  let connects = 0;
  const operation = connectWithRtcFailover({
    supportedProviders: providers, signal: controller.signal,
    async fetchCredentials() { return token.promise; },
    async connect() { connects += 1; }, async cleanup() {},
  });
  const rejected = assert.rejects(operation, { name: "AbortError" });
  controller.abort();
  await rejected;
  token.resolve(credentials("agora"));
  await turn();
  assert.equal(connects, 0, "Leaving during token retrieval cannot later open an RTC connection");
}
{
  let requested: RtcProviderId[] = [];
  await connectWithRtcFailover({
    supportedProviders: providers, signal: new AbortController().signal, excludedProviders: ["agora"],
    async fetchCredentials(excluded) { requested = excluded; return credentials("livekit"); },
    async connect() {}, async cleanup() {},
  });
  assert.deepEqual(requested, ["agora"], "Runtime quota exhaustion starts by excluding the depleted provider");
}
{
  let requests = 0, waiting = 0;
  assert.equal(await waitForRtcRoomRecovery(async () => {
    requests += 1;
    if (requests < 3) throw new RtcConnectionError("Other members are releasing", "RTC_ROOM_PROVIDER_LOCKED", 409);
    return "same-new-route";
  }, new AbortController().signal, () => { waiting += 1; }, { retryMs: 1, timeoutMs: 30 }), "same-new-route");
  assert.equal(waiting, 2);
  await assert.rejects(waitForRtcRoomRecovery(async () => {
    throw new RtcConnectionError("Still occupied", "RTC_ROOM_PROVIDER_LOCKED", 409);
  }, new AbortController().signal, () => {}, { retryMs: 1, timeoutMs: 5 }), { code: "RTC_ROOM_PROVIDER_LOCKED" });
  const controller = new AbortController();
  await assert.rejects(waitForRtcRoomRecovery(async () => {
    throw new RtcConnectionError("Still occupied", "RTC_ROOM_PROVIDER_LOCKED", 409);
  }, controller.signal, () => controller.abort(), { retryMs: 1, timeoutMs: 30 }), { name: "AbortError" });
}

// Exercise the real Agora adapter with controlled SDK promises, including SDK
// results that arrive after cancellation rather than just mocking the registry.
function agoraFixture(options: { load?: Promise<void>; join?: Promise<void>; microphone?: Promise<unknown>; failure?: Error } = {}) {
  const state = { created: 0, capture: 0, published: 0, left: 0, listenersRemoved: 0, closed: 0 };
  const events = new Map<string, (...args: unknown[]) => void>();
  const reasons: (string | undefined)[] = [];
  const client = {
    remoteUsers: [], on(name: string, listener: (...args: unknown[]) => void) { events.set(name, listener); },
    async join() { await options.join; if (options.failure) throw options.failure; },
    async leave() { state.left += 1; },
    removeAllListeners() { state.listenersRemoved += 1; },
    enableAudioVolumeIndicator() {},
    async publish() { state.published += 1; },
  };
  const track = { close() { state.closed += 1; } };
  const session = new AgoraRtcSession({ onParticipants() {}, onConnectionState(_state, reason) { reasons.push(reason); }, onCustomEvent() {}, onAudio() {} }, async () => {
    await options.load;
    return {
      createClient() { state.created += 1; return client; },
      async createMicrophoneAudioTrack() { state.capture += 1; await options.microphone; return track; },
    } as unknown as IAgoraRTC;
  });
  return { session, state, events, reasons };
}
{
  const load = deferred<void>(), controller = new AbortController();
  const { session, state } = agoraFixture({ load: load.promise });
  const operation = session.connect(credentials("agora"), true, true, async () => credentials("agora"), controller.signal);
  const rejected = assert.rejects(operation, { name: "AbortError" });
  controller.abort();
  await session.disconnect();
  load.resolve();
  await rejected;
  assert.equal(state.created, 0, "Late SDK loading must not create a client after leave");
}
{
  const join = deferred<void>(), controller = new AbortController();
  const { session, state } = agoraFixture({ join: join.promise });
  const operation = session.connect(credentials("agora"), true, true, async () => credentials("agora"), controller.signal);
  const rejected = assert.rejects(operation, { name: "AbortError" });
  await turn();
  controller.abort();
  join.resolve();
  await rejected;
  assert.equal(state.capture, 0, "A late SDK join must never open the microphone after leave");
  assert.equal(state.published, 0);
  assert.equal(session.connected, false);
  assert.ok(state.left >= 1 && state.listenersRemoved >= 1);
}
{
  const microphone = deferred<void>(), controller = new AbortController();
  const { session, state } = agoraFixture({ microphone: microphone.promise });
  const operation = session.connect(credentials("agora"), true, true, async () => credentials("agora"), controller.signal);
  const rejected = assert.rejects(operation, { name: "AbortError" });
  await turn();
  assert.equal(state.capture, 1);
  controller.abort();
  microphone.resolve();
  await rejected;
  assert.equal(state.closed, 1, "Close a microphone granted after cancellation");
  assert.equal(state.published, 0);
  assert.equal(session.connected, false);
}
{
  const { session, state } = agoraFixture({ failure: gatewayFailure });
  await assert.rejects(session.connect(credentials("agora"), true, true, async () => credentials("agora")), /CAN_NOT_GET_GATEWAY_SERVER/);
  assert.equal(session.connected, false);
  assert.equal(state.capture, 0);
  assert.equal(state.left, 1);
}
{
  const { session, events, reasons } = agoraFixture();
  await session.connect(credentials("agora"), false, true, async () => credentials("agora"));
  events.get("connection-state-change")!("DISCONNECTED", "CONNECTED", "UID_BANNED");
  assert.deepEqual(reasons, ["UID_BANNED"], "Preserve the SDK removal reason for the session recovery policy");
  await session.disconnect();
  events.get("connection-state-change")!("DISCONNECTED", "CONNECTED", "NETWORK_ERROR");
  assert.deepEqual(reasons, ["UID_BANNED"], "Discard connection callbacks from an abandoned SDK instance");
}

// Run the real RoomSession orchestration in a browser-free bundle. Only SDK
// boundaries are stubbed; join/leave, token exclusions, usage, and recovery run.
{
  const stubs: Record<string, string> = {
    "livekit-client": "export class Room {} export const DisconnectReason={4:'PARTICIPANT_REMOVED',9:'SIGNAL_CLOSE'}, AudioPresets={}, ConnectionQuality={}, LocalAudioTrack=class {}, RemoteTrackPublication=class {}, RoomEvent={}, ScreenSharePresets={}, TokenSource={}, Track={}, VideoPresets={};",
    "@tauri-apps/api/core": "export const isTauri=()=>false; export const invoke=async()=>{};",
    "./accountSession": "export const accountSession={getAccessToken:()=>null};",
    "./streamRtcSession": "export const CallingState={}, StreamTrackType={}; export const streamPublishes=()=>false; export class StreamRtcSession { call=null; async disconnect() {} }",
    "./agoraRtcSession": "export class AgoraRtcSession { connected=false; async disconnect() {} }",
    "./tencentRtcSession": "export class TencentRtcSession { constructor(callbacks) { this.callbacks=callbacks; } connected=false; async disconnect() {} }",
    "./cloudflareRtcSession": "export class CloudflareRtcSession { connected=false; async disconnect() {} }",
  };
  const bundled = await build({
    entryPoints: ["src/services/roomSession.ts"], bundle: true, write: false, format: "esm", platform: "node",
    define: { "import.meta.env": "{}" },
    plugins: [{ name: "rtc-boundaries", setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => stubs[args.path] ? { path: args.path, namespace: "rtc-stub" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "rtc-stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
    } }],
  });
  const originalFetch = globalThis.fetch;
  Object.assign(globalThis, {
    localStorage: { getItem: () => null },
    window: { setTimeout, clearTimeout, setInterval, clearInterval },
    document: { querySelectorAll: () => [], getElementById: () => null },
  });
  const { RoomSession } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
  const reports: any[] = [];
  let nextUsageCode: string | undefined;
  globalThis.fetch = async (_input, init) => {
    const report = JSON.parse(String(init?.body));
    reports.push(report);
    if (!report.leaving && nextUsageCode) {
      const code = nextUsageCode;
      nextUsageCode = undefined;
      return new Response(JSON.stringify({ code }), { status: 409 });
    }
    return new Response("{}", { status: 200 });
  };
  function sessionFixture(first: RtcProviderId = "agora") {
    const session = new RoomSession();
    session.unlockEventAudio = async () => {};
    const requests: RtcProviderId[][] = [];
    let selected: RtcProviderId = first;
    session.fetchToken = async (_room: string, _supported: RtcProviderId[], options: { excludedRtcProviders: RtcProviderId[] }) => {
      requests.push(options.excludedRtcProviders);
      if (options.excludedRtcProviders.includes(selected)) selected = providers.find((provider) => !options.excludedRtcProviders.includes(provider))!;
      return credentials(selected);
    };
    session.rtcAdapters = {
      routableProviders: () => providers,
      async connect(value: RoomConnectionCredentials) {
        session.update({ state: "connected", rtcProvider: value.routing.rtc.provider, connectionMessage: null });
      },
    };
    return { session, requests };
  }
  try {
    const { session, requests } = sessionFixture();
    const snapshots: any[] = [];
    session.subscribe((snapshot: unknown) => snapshots.push(snapshot));
    const actualConnect = session.rtcAdapters.connect;
    session.rtcAdapters.connect = async (value: RoomConnectionCredentials) => {
      if (value.routing.rtc.provider === "agora") throw gatewayFailure;
      return actualConnect(value);
    };
    await session.join("room");
    assert.equal(session.snapshot.state, "connected");
    assert.equal(session.snapshot.rtcProvider, "livekit");
    assert.deepEqual(requests, [[], ["agora"]]);
    assert.ok(snapshots.some((snapshot) => snapshot.state === "connecting" && snapshot.rtcProvider === "agora"));
    assert.ok(reports.some((report) => report.usageAccessToken === "usage-agora" && report.leaving && report.measuredFrom === report.measuredTo));
    assert.ok(reports.some((report) => report.usageAccessToken === "usage-livekit" && !report.leaving && report.measuredFrom === report.measuredTo));
    await session.leave();
    assert.equal(session.snapshot.state, "idle");
    assert.equal(session.snapshot.rtcProvider, null);
    assert.ok(reports.some((report) => report.usageAccessToken === "usage-livekit" && report.leaving));

    const runtime = sessionFixture();
    await runtime.session.join("room");
    const runtimeSessionId = runtime.session.clientSessionId;
    nextUsageCode = "RTC_PROVIDER_UNAVAILABLE";
    await runtime.session.reportRtcUsage(false, true);
    await turn();
    await runtime.session.pendingJoin;
    assert.equal(runtime.session.snapshot.state, "connected");
    assert.equal(runtime.session.snapshot.rtcProvider, "livekit");
    assert.deepEqual(runtime.requests, [[], ["agora"]], "Usage exhaustion must automatically select an alternative");
    assert.equal(runtime.session.clientSessionId, runtimeSessionId, "Recovery must retain the current join lifetime");
    nextUsageCode = "RTC_ROOM_ROUTE_CHANGED";
    await runtime.session.reportRtcUsage(false, true);
    await turn();
    await runtime.session.pendingJoin;
    assert.deepEqual(runtime.requests.at(-1), [], "A stale lease follows the shared room provider without excluding it");
    await runtime.session.leave();
    assert.equal(runtime.session.clientSessionId, undefined);
    await runtime.session.join("room");
    assert.notEqual(runtime.session.clientSessionId, runtimeSessionId, "Explicit rejoin needs a distinct lease identity");
    await runtime.session.leave();

    const cancelled = sessionFixture();
    const started = deferred<void>(), late = deferred<void>();
    cancelled.session.rtcAdapters.connect = async (value: RoomConnectionCredentials, signal: AbortSignal) => {
      started.resolve();
      await late.promise;
      throwIfRtcJoinAborted(signal);
      cancelled.session.update({ state: "connected", rtcProvider: value.routing.rtc.provider });
    };
    const joining = cancelled.session.join("room");
    await started.promise;
    await cancelled.session.leave();
    await joining;
    late.resolve();
    await turn();
    assert.equal(cancelled.session.snapshot.state, "idle", "Late initial connection must not revive a room after leave");
    assert.equal(cancelled.session.snapshot.rtcProvider, null);
    assert.equal(cancelled.requests.length, 1);

    const removed = sessionFixture();
    await removed.session.join("room");
    removed.session.handleAgoraConnectionState("DISCONNECTED", "UID_BANNED");
    await turn();
    await removed.session.pendingJoin;
    assert.equal(removed.session.snapshot.state, "failed");
    assert.match(removed.session.snapshot.connectionMessage, /UID_BANNED/);
    assert.equal(removed.requests.length, 1, "Administrative removal must not move the user to another vendor");
    removed.session.handleAgoraConnectionState("DISCONNECTED", "NETWORK_ERROR");
    await turn();
    assert.equal(removed.requests.length, 1, "A later generic SDK event cannot override a terminal removal");
    await removed.session.leave();

    const invalidated = sessionFixture(), authenticating = deferred<void>();
    invalidated.session.rtcAdapters.connect = async () => {
      authenticating.resolve();
      return new Promise<void>(() => {});
    };
    const initialJoin = invalidated.session.join("room");
    await authenticating.promise;
    invalidated.session.handleAgoraConnectionState("DISCONNECTED", "TOKEN_EXPIRE");
    await initialJoin;
    await turn();
    await invalidated.session.pendingJoin;
    assert.equal(invalidated.session.snapshot.state, "failed");
    assert.equal(invalidated.requests.length, 1, "An initial terminal SDK reason must abort instead of waiting for a retryable timeout");
    await invalidated.session.leave();

    const kicked = sessionFixture("tencent");
    await kicked.session.join("room");
    kicked.session.tencentRtc.callbacks.onFatalError(terminalRtcDisconnection("tencent", "banned"));
    await turn();
    await kicked.session.pendingJoin;
    assert.equal(kicked.session.snapshot.state, "failed");
    assert.equal(kicked.requests.length, 1, "Tencent KICKED_OUT cannot trigger migration to another vendor");
    await kicked.session.leave();

    const deleted = sessionFixture("livekit");
    await deleted.session.join("room");
    const localRoom = { removeAllListeners() {}, async disconnect() {} };
    deleted.session.room = localRoom;
    deleted.session.handleLiveKitDisconnection(localRoom, 4);
    await turn();
    await deleted.session.pendingJoin;
    assert.equal(deleted.session.snapshot.state, "failed");
    assert.equal(deleted.requests.length, 1, "LiveKit RemoveParticipant must end the call without vendor fallback");
    await deleted.session.leave();

    // Two clients initially reserve Agora. The first failure must wait for the
    // second reservation to release, then both must land on one LiveKit route.
    const allocations = new Set<string>(), tokenRequests: any[] = [];
    let roomProvider: RtcProviderId = "agora";
    const sawRoomLock = deferred<void>();
    globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(input).endsWith("/rtc/usage")) {
        const [provider, id] = body.usageAccessToken.split(":");
        if (body.leaving && roomProvider === provider) allocations.delete(id);
        return new Response("{}");
      }
      tokenRequests.push(body);
      if (body.excludedRtcProviders.includes(roomProvider)) {
        allocations.delete(body.clientSessionId);
        if (allocations.size) {
          sawRoomLock.resolve();
          return new Response(JSON.stringify({ error: "Other participants still hold the room", code: "RTC_ROOM_PROVIDER_LOCKED" }), { status: 409 });
        }
        roomProvider = providers.find((provider) => !body.excludedRtcProviders.includes(provider))!;
      }
      allocations.add(body.clientSessionId);
      const routes = routingForRtcProvider(roomProvider);
      return new Response(JSON.stringify({
        ...credentials(roomProvider), usageAccessToken: `${roomProvider}:${body.clientSessionId}`,
        routing: { rtc: { provider: roomProvider }, messaging: { provider: routes.messaging }, files: { provider: routes.files } },
      }));
    };
    const a = sessionFixture().session, b = sessionFixture().session;
    const enteredA = deferred<void>(), enteredB = deferred<void>(), failA = deferred<void>(), failB = deferred<void>();
    for (const [session, entered, fail] of [[a, enteredA, failA], [b, enteredB, failB]]) {
      session.fetchToken = RoomSession.prototype.fetchToken;
      session.rtcAdapters.connect = async (value: RoomConnectionCredentials) => {
        if (value.routing.rtc.provider === "agora") {
          entered.resolve();
          await fail.promise;
          throw gatewayFailure;
        }
        session.update({ state: "connected", rtcProvider: value.routing.rtc.provider });
      };
    }
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay: number, ...args: unknown[]) =>
      originalSetTimeout(callback, delay === 5_000 ? 1 : delay, ...args)) as typeof setTimeout;
    try {
      const joinedA = a.join("room"), joinedB = b.join("room");
      await Promise.all([enteredA.promise, enteredB.promise]);
      assert.notEqual(a.clientSessionId, b.clientSessionId);
      failA.resolve();
      await sawRoomLock.promise;
      failB.resolve();
      await Promise.all([joinedA, joinedB]);
      assert.equal(a.snapshot.state, "connected");
      assert.equal(b.snapshot.state, "connected");
      assert.equal(a.snapshot.rtcProvider, "livekit");
      assert.equal(b.snapshot.rtcProvider, "livekit");
      assert.equal(allocations.size, 2);
      assert.equal(new Set(tokenRequests.map((body) => body.clientSessionId)).size, 2);
      await Promise.all([a.leave(), b.leave()]);
      assert.equal(allocations.size, 0);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log("RTC resilience passed: bounded fallback, room coordination, real join/leave and usage recovery, and late SDK/media cleanup");
