import assert from "node:assert/strict";
import {
  knownRtcProviders,
  parseRtcProviders,
  rtcCapabilities,
  selectRtcProvider,
  updateProviderHealth,
  type RoutingEnvironment,
} from "../worker/src/providerRouting";
import { targetRtcProviders as clientTargetRtcProviders } from "../src/core/rtcProviders";
import { targetRtcProviders as workerTargetRtcProviders } from "../worker/src/rtcProviderCatalog";

function testEnvironment() {
  const values = new Map<string, string>();
  const kv = {
    async get(key: string, type?: string) {
      const value = values.get(key) ?? null;
      return type === "json" && value ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) { values.set(key, value); },
    async delete(key: string) { values.delete(key); },
  } as unknown as KVNamespace;
  return {
    PRIVATE_ROOMS: kv,
    RTC_PROVIDER_ORDER: "stream,agora,tencent,cloudflare-realtime,whereby,100ms,daily,livekit",
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
    DAILY_API_KEY: "configured",
  } satisfies RoutingEnvironment;
}

assert.deepEqual(parseRtcProviders(["livekit", "unknown", "livekit"]), ["livekit"]);
assert.deepEqual(parseRtcProviders(undefined), ["livekit"]);
assert.deepEqual(workerTargetRtcProviders, clientTargetRtcProviders);
assert.equal(workerTargetRtcProviders.length, 11);
assert.equal(knownRtcProviders.includes("daily"), true);

const environment = testEnvironment();
const capabilities = await rtcCapabilities(environment);
assert.equal(capabilities.find((item) => item.provider === "stream")?.ready, true);
assert.equal(capabilities.find((item) => item.provider === "agora")?.ready, true);
assert.equal(capabilities.find((item) => item.provider === "tencent")?.ready, true);
assert.equal(capabilities.find((item) => item.provider === "cloudflare-realtime")?.ready, false);
assert.match(capabilities.find((item) => item.provider === "cloudflare-realtime")?.reason || "", /stale/i);
assert.equal(capabilities.find((item) => item.provider === "whereby")?.ready, true);
assert.equal(capabilities.find((item) => item.provider === "daily")?.ready, true);
assert.equal(capabilities.find((item) => item.provider === "livekit")?.ready, true);
assert.equal((await selectRtcProvider(environment, "Daily", ["daily", "livekit"]))?.provider, "daily");
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
assert.equal((await selectRtcProvider(environment, "Whereby", ["whereby", "livekit"]))?.provider, "whereby");
assert.equal((await selectRtcProvider(environment, "Main", ["livekit"]))?.provider, "livekit");

await updateProviderHealth(environment, "livekit", { usedPercent: 90 });
assert.equal((await selectRtcProvider(environment, "Main", ["livekit"]))?.provider, "livekit");

await updateProviderHealth(environment, "livekit", { usedPercent: 95 });
assert.equal(await selectRtcProvider(environment, "Another", ["livekit"]), null);

await updateProviderHealth(environment, "livekit", { usedPercent: 0, disabled: true });
assert.equal(await selectRtcProvider(environment, "Disabled", ["livekit"]), null);

console.log("Provider routing tests passed: 23");
