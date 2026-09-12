import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
// Match Wrangler's CJS SDK interop; direct ESM import of agora-token is unsupported.
const bundle = await build({ entryPoints: [fileURLToPath(new URL("../worker/src/index.ts", import.meta.url))], bundle: true, platform: "node", format: "cjs", write: false });
const workerModule = { exports: {} as { PresenceHub: new (state: unknown, env: unknown) => { fetch(request: Request): Promise<Response> } } };
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
