import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const targetProviders = [
  "stream",
  "agora",
  "tencent",
  "cloudflare-realtime",
  "livekit",
  "whereby",
  "jaas",
  "mirotalk",
];

const windowsSession = await readFile(new URL("../src/services/roomSession.ts", import.meta.url), "utf8");
const workerCatalog = await readFile(new URL("../worker/src/rtcProviderCatalog.ts", import.meta.url), "utf8");
const androidRoot = process.env.MHTALK_ANDROID_ROOT || fileURLToPath(new URL("../../MHTalk-Android", import.meta.url));

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

const androidSession = await readOptional(`${androidRoot}/app/src/main/java/com/mhlko/talk/call/SessionViewModel.kt`);
const androidCapabilities = await readOptional(`${androidRoot}/app/src/main/java/com/mhlko/talk/data/ClientServiceCapabilities.kt`);

for (const provider of targetProviders) {
  assert.match(windowsSession, new RegExp(`provider:\\s*"${provider.replace("-", "\\-")}"`));
  assert.match(workerCatalog, new RegExp(`"${provider.replace("-", "\\-")}"`));
  if (androidSession) {
    assert.match(androidSession, new RegExp(`RtcProviderAdapter\\("${provider.replace("-", "\\-")}"`));
  }
}

if (androidCapabilities) {
  for (const provider of ["jaas", "mirotalk"]) {
    assert.match(androidCapabilities, new RegExp(`"${provider}"`));
  }
}

console.log(
  androidSession && androidCapabilities
    ? "Client adapter parity verified for all 8 target RTC providers"
    : "Windows and Worker adapter parity verified; Android parity is enforced by the Android repository CI",
);
