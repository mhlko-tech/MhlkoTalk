import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const targetProviders = [
  "stream",
  "agora",
  "tencent",
  "cloudflare-realtime",
  "livekit",
  "100ms",
  "cometchat",
  "whereby",
  "jaas",
  "mirotalk",
  "videosdk",
];

const windowsSession = await readFile(new URL("../src/services/roomSession.ts", import.meta.url), "utf8");
const androidSession = await readFile(
  fileURLToPath(new URL("../../MHTalk-Android/app/src/main/java/com/mhlko/talk/call/SessionViewModel.kt", import.meta.url)),
  "utf8",
);
const androidCapabilities = await readFile(
  fileURLToPath(new URL("../../MHTalk-Android/app/src/main/java/com/mhlko/talk/data/ClientServiceCapabilities.kt", import.meta.url)),
  "utf8",
);

for (const provider of targetProviders) {
  assert.match(windowsSession, new RegExp(`provider:\\s*"${provider.replace("-", "\\-")}"`));
  assert.match(androidSession, new RegExp(`RtcProviderAdapter\\("${provider.replace("-", "\\-")}"`));
}

for (const provider of ["100ms", "cometchat", "jaas", "mirotalk", "videosdk"]) {
  assert.match(androidCapabilities, new RegExp(`"${provider}"`));
}

console.log("Client adapter parity verified for all 11 target RTC providers");
