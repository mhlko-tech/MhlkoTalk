import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
// Match Wrangler's CJS SDK interop; direct ESM import of agora-token is unsupported.
const bundle = await build({ entryPoints: [fileURLToPath(new URL("../worker/src/index.ts", import.meta.url))], bundle: true, platform: "node", format: "cjs", write: false });
const workerModule = { exports: {} as { PresenceHub: new (state: unknown, env: unknown) => { fetch(request: Request): Promise<Response> }; default: { fetch(request: Request, env: unknown): Promise<Response> } } };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(new URL("../worker/package.json", import.meta.url)), workerModule, workerModule.exports);
const { PresenceHub } = workerModule.exports;

// Exercise the actual Durable Object HTTP handlers, including concurrent joins
// and zero-duration presence, without external services or real media.
const values = new Map<string, unknown>();
let transactionQueue = Promise.resolve();
let alarm: number | null = null;
const storage = {
  async get<T>(key: string) { return structuredClone(values.get(key)) as T | undefined; },
  async put(key: string, value: unknown) { values.set(key, structuredClone(value)); },
  async delete(key: string | string[]) { for (const item of Array.isArray(key) ? key : [key]) values.delete(item); },
  async list<T>({ prefix }: { prefix: string }) { return new Map([...values].filter(([key]) => key.startsWith(prefix))) as Map<string, T>; },
  async getAlarm() { return alarm; },
  async setAlarm(value: number) { alarm = value; },
  async transaction<T>(callback: (transaction: typeof storage) => Promise<T>): Promise<T> {
    const result = transactionQueue.then(() => callback(storage));
    transactionQueue = result.then(() => undefined, () => undefined);
    return result;
  },
};
const hub = new PresenceHub({ storage } as unknown as DurableObjectState, {} as never);
const post = (path: string, body: unknown) => hub.fetch(new Request(`https://internal${path}`, { method: "POST", body: JSON.stringify(body) }));
const allocate = (subject: string, excluded: string[] = []) => post("/room-route", {
  room: "room-one", subject, eligible: ["agora", "livekit"], acceptingNewRooms: ["agora", "livekit"], excluded,
});
const [a, b] = await Promise.all([allocate("a"), allocate("b")]);
const aRoute = await a.json() as { selected: string; route: { id: string } };
const bRoute = await b.json() as { selected: string; route: { id: string } };
assert.equal(aRoute.selected, "agora");
assert.equal(bRoute.selected, "agora");
assert.equal(aRoute.route.id, bRoute.route.id);
const count = () => hub.fetch(new Request("https://internal/room-count?room=room-one")).then((response) => response.json() as Promise<{ count: number }>);
assert.equal((await count()).count, 0, "credentials alone must not count as connected");
const heartbeat = (subject: string, provider: string, routeId: string, leaving = false) => post("/rtc-usage", {
  subject, provider, routeId, leaving, room: "room-one", amount: null,
});
assert.equal((await heartbeat("a", "agora", aRoute.route.id)).status, 200);
assert.equal((await count()).count, 1);
assert.equal((await heartbeat("a", "agora", aRoute.route.id, true)).status, 200);
assert.equal((await heartbeat("a", "agora", aRoute.route.id)).status, 409, "late heartbeat cannot revive a released join");
assert.equal((await (await allocate("a", ["agora"])).json() as { locked: boolean }).locked, true);
await heartbeat("b", "agora", bRoute.route.id, true);
const next = await (await allocate("a", ["agora"])).json() as { selected: string; route: { id: string } };
assert.equal(next.selected, "livekit");
assert.equal((await heartbeat("a", "agora", aRoute.route.id)).status, 409);
assert.equal((await heartbeat("a", "livekit", next.route.id)).status, 200);
assert.equal((await count()).count, 1);
await storage.delete("room-route:room-one");
assert.equal((await heartbeat("a", "livekit", next.route.id)).status, 409, "expired route must require reallocation");
console.log("Room coordination HTTP tests passed: concurrent allocation, real presence, handoff, stale heartbeat rejection");

const poolEnv = { LIVEKIT_URL: "https://primary.livekit.cloud", LIVEKIT_API_KEY: "key", LIVEKIT_API_SECRET: "secret",
  LIVEKIT_ACCOUNTS_JSON: JSON.stringify([{ id: "mhtalk-02", url: "wss://second.livekit.cloud", apiKey: "key2", apiSecret: "secret2" }]) };
const poolHub = new PresenceHub({ storage }, poolEnv);
await storage.put("provider-health:v1", { livekit: { usedPercent: 73.7, disabled: false, updatedAt: new Date().toISOString() } });
const poolPost = (path: string, body: unknown) => poolHub.fetch(new Request(`https://internal${path}`, { method: "POST", body: JSON.stringify(body) }));
const poolAllocate = async(subject: string) => (await poolPost("/room-route", {
  room: "pool-room", subject, eligible: ["livekit"], acceptingNewRooms: ["livekit"], excluded: [],
})).json() as Promise<{ selected: string | null; locked: boolean; route: { id: string; livekitAccountId: string } }>;
const [pa, pb] = await Promise.all([poolAllocate("pa"), poolAllocate("pb")]);
assert.equal(pa.route.livekitAccountId, "mhtalk-02");
assert.equal(pb.route.id, pa.route.id);
assert.equal(pb.route.livekitAccountId, pa.route.livekitAccountId);
const poolBeat = (subject: string, routeId: string, amount: number | null, usageWindow: number) => poolPost("/rtc-usage", {
  room: "pool-room", subject, provider: "livekit", routeId, amount, usageWindow, leaving: false,
});
await poolBeat("pa", pa.route.id, 1, 1);
await poolBeat("pa", pa.route.id, 1, 1);
let poolCount = await storage.get<{ cycle: string; minutes: Record<string, number> }>("livekit-pool-usage");
assert.equal(poolCount!.minutes["mhtalk-02"], 1, "duplicate usage must be billed once");
poolCount!.minutes["mhtalk-02"] = 4500;
await storage.put("livekit-pool-usage", poolCount);
assert.equal((await poolAllocate("pc")).locked, true, "cannot move only one member to another account");
assert.equal((await poolBeat("pa", pa.route.id, null, 2)).status, 409);
assert.equal((await poolBeat("pb", pb.route.id, null, 2)).status, 409);
const pc = await poolAllocate("pc");
assert.equal(pc.route.livekitAccountId, "mhtalk-01");
assert.notEqual(pc.route.id, pa.route.id, "project switch must invalidate the previous route generation");
assert.equal((await poolBeat("pa", pa.route.id, 1, 3)).status, 409);
poolCount = await storage.get("livekit-pool-usage");
assert.equal(poolCount!.minutes["mhtalk-02"], 4500, "stale route reports must not debit the new account");
console.log("LiveKit pool HTTP tests passed: concurrent project pinning, deduplicated usage, cutoff handoff, stale route protection");

await storage.delete("livekit-pool-usage");
const brokerEnv = { ...poolEnv, INVITE_SIGNING_KEY: "integration-test-key", RTC_PROVIDER_ORDER: "livekit",
  PRIVATE_ROOMS: { async get() { return null; } },
  PRESENCE: { idFromName() { return "global"; }, get() { return { fetch(input: string, init?: RequestInit) { return poolHub.fetch(new Request(input, init)); } }; } },
};
const brokerResponse = await workerModule.exports.default.fetch(new Request("https://test/livekit/token", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ roomName: "Main", supportedRtcProviders: ["livekit"], clientSessionId: crypto.randomUUID() }),
}), brokerEnv);
assert.equal(brokerResponse.status, 200);
const broker = await brokerResponse.json() as { token: string; serverUrl: string; routing: { rtc: { serverUrl: string } }; usageAccessToken: string };
assert.equal(broker.serverUrl, "wss://second.livekit.cloud");
assert.equal(broker.routing.rtc.serverUrl, broker.serverUrl);
assert.equal(JSON.parse(Buffer.from(broker.token.split(".")[1], "base64url").toString()).iss, "key2");
assert.ok(broker.usageAccessToken);
console.log("LiveKit broker test passed: selected project URL and signed credential belong to the same account");
