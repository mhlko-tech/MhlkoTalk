import assert from "node:assert/strict";

const base = process.env.MHTALK_AUTH_TEST_ORIGIN || "https://mhtalk-token-service.mhlkotalk.workers.dev";

async function request(path, init) {
  const response = await fetch(new URL(path, base), init);
  const body = await response.json();
  return { response, body };
}

const reserved = await request("/auth/username-available?username=admin");
assert.equal(reserved.response.status, 400);
assert.equal(reserved.body.available, false);

const invalid = await request("/auth/username-available?username=ab");
assert.equal(invalid.response.status, 400);

const candidate = `gateway_test_${Date.now().toString(36)}`;
const available = await request(`/auth/username-available?username=${candidate}`);
assert.equal(available.response.status, 200);
assert.equal(available.body.available, true);

const login = await request("/auth/login", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ identifier: candidate, password: "definitely-wrong" }),
});
assert.equal(login.response.status, 400);
assert.equal(login.body.error, "Username/email or password is incorrect");

for (const [path, method] of [
  ["/auth/onboarding", "GET"],
  ["/auth/onboarding/start", "POST"],
  ["/auth/onboarding/complete", "POST"],
  ["/auth/password-enabled", "POST"],
]) {
  const result = await request(path, method === "POST" ? {
    method, headers: { "content-type": "application/json" }, body: "{}",
  } : undefined);
  assert.equal(result.response.status, 401);
  assert.equal(result.body.error, "Sign in is required");
}

console.log("Authentication gateway tests passed: 8");
