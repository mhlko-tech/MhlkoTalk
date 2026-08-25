import assert from "node:assert/strict";
import { emailError, passwordError, usernameError } from "../src/core/authRules";

for (const username of ["husam_98", "User123", "abc"]) assert.equal(usernameError(username), null);
for (const username of ["ab", "bad name", "name!", "x".repeat(33)]) assert.match(usernameError(username) || "", /Username/);
for (const username of ["admin", "MHTalk", "SUPPORT"]) assert.equal(usernameError(username), "Username is unavailable");
assert.equal(emailError("user@example.com"), null);
assert.match(emailError("not-an-email") || "", /email/i);
assert.match(passwordError("short") || "", /10/);
assert.equal(passwordError("long-enough-password"), null);
assert.match(passwordError("x".repeat(129)) || "", /128/);

console.log("Authentication rule tests passed: 13");
