import assert from "node:assert/strict";
import { RtcAdapterRegistry, type RtcMediaCapabilities } from "../src/services/rtcAdapterRegistry";

const liveKitParity: RtcMediaCapabilities = {
  nativeMhtalkControls: true,
  independentScreenAudio: true,
  stableAudioOutputRoute: true,
  crossPlatformParity: true,
};
const desktopOnly = { ...liveKitParity, crossPlatformParity: false };
const embedded = { ...liveKitParity, nativeMhtalkControls: false };
const connect = async () => undefined;
const registry = new RtcAdapterRegistry([
  { provider: "stream", mediaCapabilities: desktopOnly, connect },
  { provider: "agora", mediaCapabilities: liveKitParity, connect },
  { provider: "tencent", mediaCapabilities: liveKitParity, connect },
  { provider: "cloudflare-realtime", mediaCapabilities: desktopOnly, connect },
  { provider: "jaas", mediaCapabilities: embedded, connect },
  { provider: "livekit", mediaCapabilities: liveKitParity, connect },
]);

assert.deepEqual(registry.routableProviders(), ["agora", "tencent", "livekit"]);
assert.deepEqual(registry.supportedProviders(), [
  "stream",
  "agora",
  "tencent",
  "cloudflare-realtime",
  "jaas",
  "livekit",
]);

console.log("Cross-platform LiveKit media behavior contract verified");
