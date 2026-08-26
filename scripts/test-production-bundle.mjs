import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const assetsDirectory = fileURLToPath(new URL("../dist/assets/", import.meta.url));
const files = (await readdir(assetsDirectory)).filter((name) => name.endsWith(".js"));
const bundle = (
  await Promise.all(files.map((name) => readFile(join(assetsDirectory, name), "utf8")))
).join("\n");

const requiredProductionValues = [
  "https://mhtalk-token-service.mhlkotalk.workers.dev",
  "/livekit/token",
  "wss://mhtalkremake-utuei6i7.livekit.cloud",
  "https://fcadjrqrrzcvbyqrgnnm.supabase.co",
];

const missing = requiredProductionValues.filter((value) => !bundle.includes(value));
if (missing.length > 0) {
  throw new Error(`Production bundle is missing required service configuration: ${missing.join(", ")}`);
}

console.log(`Production bundle configuration verified (${requiredProductionValues.length} values)`);
