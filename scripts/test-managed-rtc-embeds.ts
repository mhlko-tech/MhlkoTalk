import assert from "node:assert/strict";
import { handleManagedRtcEmbed } from "../worker/src/managedRtcProviders";

const values = new Map<string, string>();
const kv = {
  async get(key: string, type?: string) {
    const value = values.get(key) ?? null;
    return type === "json" && value ? JSON.parse(value) : value;
  },
  async put(key: string, value: string) { values.set(key, value); },
  async delete(key: string) { values.delete(key); },
} as unknown as KVNamespace;
const env = { PRIVATE_ROOMS: kv };

const cases = [
  ["100ms", { provider: "100ms", joinUrl: "https://demo.app.100ms.live/meeting/abc", name: "Tester" }, "100ms.live"],
  ["cometchat", { provider: "cometchat", appId: "app", region: "us", authToken: "auth", sessionId: "room", name: "Tester" }, "calls-sdk-javascript"],
  ["jaas", { provider: "jaas", appId: "vpaas-test", jwt: "jwt", roomAlias: "room", name: "Tester" }, "JitsiMeetExternalAPI"],
  ["mirotalk", { provider: "mirotalk", joinUrl: "https://129-159-223-64.sslip.io/join?room=test", name: "Tester" }, "sslip.io"],
  ["videosdk", { provider: "videosdk", joinUrl: "https://embed.videosdk.live/rtc-js-prebuilt/0.3.43", name: "Tester" }, "videosdk.live"],
] as const;

for (const [provider, payload, expected] of cases) {
  const ticket = `${provider}-ticket`;
  values.set(`rtc:embed:ticket:${ticket}`, JSON.stringify(payload));
  const response = await handleManagedRtcEmbed(
    new Request(`https://worker.example/rtc/embed/${provider}?ticket=${ticket}`),
    env,
    provider,
  );
  assert(response);
  assert.equal(response.status, 200);
  assert.match(await response.text(), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(values.has(`rtc:embed:ticket:${ticket}`), false);
  assert.match(response.headers.get("permissions-policy") || "", /camera=\*/);
}

const expired = await handleManagedRtcEmbed(
  new Request("https://worker.example/rtc/embed/100ms?ticket=missing"),
  env,
  "100ms",
);
assert(expired);
assert.match(await expired.text(), /expired/i);

console.log("Managed RTC embed tests passed: 6");
