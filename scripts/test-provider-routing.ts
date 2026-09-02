import assert from "node:assert/strict";
import {
  knownRtcProviders,
  parseRtcProviders,
  rtcCapabilities,
  selectRtcProvider,
  updateProviderHealth,
  updateProviderHealthBatch,
  type RoutingEnvironment,
} from "../worker/src/providerRouting";
import { targetRtcProviders as clientTargetRtcProviders } from "../src/core/rtcProviders";
import { routingForRtcProvider, routingIsSupported } from "../src/core/serviceRouting";
import { targetRtcProviders as workerTargetRtcProviders } from "../worker/src/rtcProviderCatalog";

function testEnvironment() {
  const values = new Map<string, string>();
  let providerHealth: Record<string, { usedPercent: number; disabled: boolean; updatedAt: string }> = {};
  const kv = {
    async get(key: string, type?: string) {
      const value = values.get(key) ?? null;
      return type === "json" && value ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) { values.set(key, value); },
    async delete(key: string) { values.delete(key); },
  } as unknown as KVNamespace;
  const providerHealthStub = {
    async fetch(_input: RequestInfo | URL, init?: RequestInit) {
      if ((init?.method || "GET") === "POST") {
        const body = JSON.parse(String(init?.body || "{}")) as {
          updates?: Record<string, { usedPercent?: number; disabled?: boolean }>;
        };
        const updatedAt = new Date().toISOString();
        for (const [provider, update] of Object.entries(body.updates || {})) {
          const current = providerHealth[provider];
          providerHealth[provider] = {
            usedPercent: update.usedPercent ?? current?.usedPercent ?? 0,
            disabled: update.disabled ?? current?.disabled ?? false,
            updatedAt,
          };
        }
      }
      return Response.json(providerHealth);
    },
  } as unknown as DurableObjectStub;
  return {
    PRIVATE_ROOMS: kv,
    PRESENCE: {
      idFromName() { return {} as DurableObjectId; },
      get() { return providerHealthStub; },
    } as unknown as DurableObjectNamespace,
    RTC_PROVIDER_ORDER: "stream,agora,tencent,cloudflare-realtime,livekit,whereby,jaas,mirotalk,daily",
    LIVEKIT_URL: "https://example.livekit.cloud",
    LIVEKIT_API_KEY: "key",
    LIVEKIT_API_SECRET: "secret",
    STREAM_API_KEY: "configured",
    STREAM_API_SECRET: "configured",
    AGORA_APP_ID: "configured",
    AGORA_APP_CERTIFICATE: "configured",
    TENCENT_SDK_APP_ID: "1400000000",
    TENCENT_SECRET_KEY: "configured",
    CLOUDFLARE_REALTIME_APP_ID: "configured",
    CLOUDFLARE_REALTIME_API_TOKEN: "configured",
    WHEREBY_API_KEY: "configured",
    JAAS_APP_ID: "configured",
    JAAS_KEY_ID: "configured",
    JAAS_PRIVATE_KEY: "configured",
    MIROTALK_BASE_URL: "https://mirotalk.example",
    MIROTALK_API_KEY_SECRET: "configured",
    MIROTALK_HOST_USERNAME: "configured",
    MIROTALK_HOST_PASSWORD: "configured",
    DAILY_API_KEY: "configured",
  } satisfies RoutingEnvironment;
}

assert.deepEqual(parseRtcProviders(["livekit", "unknown", "livekit"]), ["livekit"]);
assert.deepEqual(parseRtcProviders(undefined), ["livekit"]);
assert.deepEqual(workerTargetRtcProviders, clientTargetRtcProviders);
assert.equal(workerTargetRtcProviders.length, 8);
assert.equal(knownRtcProviders.includes("daily"), true);
assert.deepEqual(routingForRtcProvider("stream"), {
  messaging: "stream-events",
  files: "supabase-storage",
});
assert.equal(routingIsSupported("stream", ["stream-events"], ["livekit-stream"]), false);
assert.equal(routingIsSupported("stream", ["stream-events"], ["supabase-storage"]), true);
assert.equal(routingIsSupported("livekit", ["livekit-data"], ["livekit-stream"]), true);

const environment = testEnvironment();
const missingTelemetry = await rtcCapabilities(environment);
assert.equal(missingTelemetry.find((item) => item.provider === "stream")?.ready, false);
assert.match(missingTelemetry.find((item) => item.provider === "stream")?.reason || "", /stale/i);
for (const provider of knownRtcProviders.filter((item) => item !== "cloudflare-realtime")) {
  await updateProviderHealth(environment, provider, { usedPercent: 0 });
}
const capabilities = await rtcCapabilities(environment);
assert.equal(capabilities.find((item) => item.provider === "stream")?.ready, true);
assert.equal(capabilities.find((item) => item.provider === "agora")?.ready, true);
assert.equal(capabilities.find((item) => item.provider === "tencent")?.ready, true);
assert.equal(capabilities.find((item) => item.provider === "cloudflare-realtime")?.ready, false);
assert.match(capabilities.find((item) => item.provider === "cloudflare-realtime")?.reason || "", /stale/i);
assert.equal(capabilities.find((item) => item.provider === "whereby")?.ready, true);
for (const provider of ["jaas", "mirotalk"] as const) {
  const capability = capabilities.find((item) => item.provider === provider);
  assert.equal(capability?.adapterReady, true);
  assert.equal(capability?.ready, true);
}
assert.equal(capabilities.find((item) => item.provider === "daily")?.ready, true);
assert.equal(capabilities.find((item) => item.provider === "livekit")?.ready, true);
assert.equal((await selectRtcProvider(environment, "Daily", ["daily"]))?.provider, "daily");
assert.equal((await selectRtcProvider(environment, "Stream", ["stream", "livekit"]))?.provider, "stream");
assert.equal((await selectRtcProvider(environment, "Agora", ["agora", "livekit"]))?.provider, "agora");
assert.equal((await selectRtcProvider(environment, "Tencent", ["tencent", "livekit"]))?.provider, "tencent");
await updateProviderHealth(environment, "cloudflare-realtime", { usedPercent: 0 });
assert.equal((await selectRtcProvider(environment, "Cloudflare", ["cloudflare-realtime"]))?.provider, "cloudflare-realtime");
await updateProviderHealth(environment, "cloudflare-realtime", { usedPercent: 50 });
assert.equal((await rtcCapabilities(environment)).find((item) => item.provider === "cloudflare-realtime")?.state, "draining");
await updateProviderHealth(environment, "cloudflare-realtime", { usedPercent: 55 });
assert.equal((await selectRtcProvider(environment, "Cloudflare", ["cloudflare-realtime"]))?.provider, "cloudflare-realtime");
assert.equal(await selectRtcProvider(environment, "Cloudflare-new", ["cloudflare-realtime"]), null);
await updateProviderHealth(environment, "cloudflare-realtime", { usedPercent: 60 });
assert.equal(await selectRtcProvider(environment, "Cloudflare", ["cloudflare-realtime"]), null);
assert.equal((await selectRtcProvider(environment, "Whereby", ["whereby"]))?.provider, "whereby");
assert.equal((await selectRtcProvider(environment, "JaaS", ["jaas"]))?.provider, "jaas");
await updateProviderHealth(environment, "jaas", { usedPercent: 72 });
assert.equal((await rtcCapabilities(environment)).find((item) => item.provider === "jaas")?.state, "draining");
assert.equal(await selectRtcProvider(environment, "JaaS-new", ["jaas"]), null);
await updateProviderHealth(environment, "jaas", { usedPercent: 76 });
assert.equal(await selectRtcProvider(environment, "JaaS", ["jaas"]), null);
assert.equal((await selectRtcProvider(environment, "MiroTalk", ["mirotalk"]))?.provider, "mirotalk");
assert.equal((await selectRtcProvider(environment, "Main", ["livekit"]))?.provider, "livekit");

await updateProviderHealth(environment, "livekit", { usedPercent: 70 });
assert.equal((await selectRtcProvider(environment, "Main", ["livekit"]))?.provider, "livekit");
assert.equal(await selectRtcProvider(environment, "LiveKit-new", ["livekit"]), null);

await updateProviderHealth(environment, "livekit", { usedPercent: 75 });
assert.equal(await selectRtcProvider(environment, "Another", ["livekit"]), null);

await updateProviderHealth(environment, "livekit", { usedPercent: 0, disabled: true });
assert.equal(await selectRtcProvider(environment, "Disabled", ["livekit"]), null);

const batchedEnvironment = testEnvironment();
let batchKvWrites = 0;
const batchValues = new Map<string, string>();
batchedEnvironment.PRIVATE_ROOMS = {
  async get(key: string, type?: string) {
    const value = batchValues.get(key) ?? null;
    return type === "json" && value ? JSON.parse(value) : value;
  },
  async put(key: string, value: string) { batchKvWrites += 1; batchValues.set(key, value); },
} as unknown as KVNamespace;
await updateProviderHealthBatch(batchedEnvironment, {
  stream: { usedPercent: 1, disabled: false },
  agora: { usedPercent: 2, disabled: false },
  whereby: { usedPercent: 3, disabled: true },
});
assert.equal(batchKvWrites, 0, "provider telemetry must not spend KV writes");
assert.equal((await rtcCapabilities(batchedEnvironment)).find((item) => item.provider === "stream")?.usedPercent, 1);

const readBoundEnvironment = testEnvironment();
let capabilityReads = 0;
const readBoundKv = readBoundEnvironment.PRIVATE_ROOMS;
readBoundEnvironment.PRIVATE_ROOMS = {
  async get(key: string, type?: string) {
    capabilityReads += 1;
    return readBoundKv.get(key, type as "text");
  },
  async put() {},
} as unknown as KVNamespace;
await rtcCapabilities(readBoundEnvironment);
assert.equal(capabilityReads, 0, "capability discovery must not spend KV reads");

console.log("Provider routing tests passed for all 8 target providers plus legacy Daily");
