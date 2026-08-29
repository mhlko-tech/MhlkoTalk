import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { inflateSync } from "node:zlib";
import { generateTencentUserSig } from "../worker/src/tencentUserSig";

const sdkAppId = 1_400_000_001;
const identity = "mhtalk_test_user";
const secret = "test-secret-never-used-in-production";
const expires = 86_400;
const issuedAt = 1_800_000_000;
const token = await generateTencentUserSig(
  sdkAppId,
  identity,
  secret,
  expires,
  issuedAt,
);

assert.match(token, /^[A-Za-z0-9_*-]+$/);
const encoded = token
  .replaceAll("*", "+")
  .replaceAll("-", "/")
  .replaceAll("_", "=");
const ticket = JSON.parse(inflateSync(Buffer.from(encoded, "base64")).toString()) as Record<string, unknown>;
assert.equal(ticket["TLS.ver"], "2.0");
assert.equal(ticket["TLS.identifier"], identity);
assert.equal(ticket["TLS.sdkappid"], sdkAppId);
assert.equal(ticket["TLS.time"], issuedAt);
assert.equal(ticket["TLS.expire"], expires);

const contentToSign =
  `TLS.identifier:${identity}\n` +
  `TLS.sdkappid:${sdkAppId}\n` +
  `TLS.time:${issuedAt}\n` +
  `TLS.expire:${expires}\n`;
assert.equal(
  ticket["TLS.sig"],
  createHmac("sha256", secret).update(contentToSign).digest("base64"),
);

console.log("Tencent UserSig tests passed: 7");
