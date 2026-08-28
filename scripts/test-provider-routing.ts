import assert from "node:assert/strict";
import {
  parseRtcProviders,
  rtcCapabilities,
  selectRtcProvider,
  updateProviderHealth,
  type RoutingEnvironment,
} from "../worker/src/providerRouting";

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
    RTC_PROVIDER_ORDER: "stream,agora,100ms,daily,livekit",
    LIVEKIT_URL: "https://example.livekit.cloud",
    LIVEKIT_API_KEY: "key",
    LIVEKIT_API_SECRET: "secret",
    STREAM_API_KEY: "configured",
    STREAM_API_SECRET: "configured",
  } satisfies RoutingEnvironment;
}

assert.deepEqual(parseRtcProviders(["livekit", "unknown", "livekit"]), ["livekit"]);
assert.deepEqual(parseRtcProviders(undefined), ["livekit"]);

const environment = testEnvironment();
const capabilities = await rtcCapabilities(environment);
assert.equal(capabilities.find((item) => item.provider === "stream")?.ready, false);
assert.equal(capabilities.find((item) => item.provider === "livekit")?.ready, true);
assert.equal((await selectRtcProvider(environment, "Main", ["livekit"]))?.provider, "livekit");

await updateProviderHealth(environment, "livekit", { usedPercent: 90 });
assert.equal((await selectRtcProvider(environment, "Main", ["livekit"]))?.provider, "livekit");

await updateProviderHealth(environment, "livekit", { usedPercent: 95 });
assert.equal(await selectRtcProvider(environment, "Another", ["livekit"]), null);

await updateProviderHealth(environment, "livekit", { usedPercent: 0, disabled: true });
assert.equal(await selectRtcProvider(environment, "Disabled", ["livekit"]), null);

console.log("Provider routing tests passed: 8");
