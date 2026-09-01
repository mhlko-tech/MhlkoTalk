const endpoint = process.env.MHTALK_CAPABILITIES_URL ||
  "https://mhtalk-token-service.mhlkotalk.workers.dev/service/capabilities";
const requiredProviders = (process.env.MHTALK_REQUIRED_RTC_PROVIDERS ||
  "stream,agora,cloudflare-realtime,jaas,mirotalk")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const response = await fetch(endpoint, { headers: { accept: "application/json" } });
if (!response.ok) throw new Error(`Capability endpoint failed with HTTP ${response.status}`);
const payload = await response.json();
if (!Array.isArray(payload.rtc)) throw new Error("Capability endpoint did not return an RTC provider list");

const providers = new Map(payload.rtc.map((item) => [item.provider, item]));
const failures = [];
for (const provider of requiredProviders) {
  const capability = providers.get(provider);
  if (!capability) failures.push(`${provider}: missing from capability response`);
  else if (!capability.ready) failures.push(`${provider}: ${capability.state} (${capability.reason || "not ready"})`);
}

for (const capability of payload.rtc) {
  const usedPercent = Number(capability.usedPercent);
  if (Number.isFinite(usedPercent) && usedPercent >= 80) {
    failures.push(`${capability.provider}: unsafe usage ${usedPercent}%`);
  }
}

const summary = payload.rtc.map((item) =>
  `${item.provider}=${item.state}/${Number(item.usedPercent) || 0}%`,
).join(", ");
console.log(`RTC provider health: ${summary}`);
if (failures.length) throw new Error(`Provider monitor failed:\n${failures.join("\n")}`);
console.log(`Provider monitor passed for required routes: ${requiredProviders.join(", ")}`);
