import assert from "node:assert/strict";
import test from "node:test";
import { requireAccess, verifyAccessJwt } from "../functions/api/_shared/access-auth.js";
import { authenticatedEnv, getTestAuth } from "./support/access-test-auth.js";

const url = "https://rabbitry.example/api/rabbits";

function request(token, useCookie = false) {
  const headers = new Headers();
  if (token) {
    headers.set(
      useCookie ? "Cookie" : "Cf-Access-Jwt-Assertion",
      useCookie ? `other=value; CF_Authorization=${token}` : token
    );
  }
  return new Request(url, { headers });
}

test("valid signed Access JWT is accepted from header and compatibility cookie", async () => {
  const auth = await getTestAuth();
  const env = await authenticatedEnv();

  assert.equal((await verifyAccessJwt(request(auth.validToken), env)).ok, true);
  assert.equal((await verifyAccessJwt(request(auth.validToken, true), env)).ok, true);
});

test("missing and forged Access tokens are rejected without details", async () => {
  const auth = await getTestAuth();
  const env = await authenticatedEnv();
  const forged = auth.validToken.slice(0, -1) + (auth.validToken.endsWith("A") ? "B" : "A");

  assert.equal((await verifyAccessJwt(request(null), env)).reason, "missing");
  assert.equal((await verifyAccessJwt(request(forged), env)).reason, "invalid");

  const response = await requireAccess(request(forged), env);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Authentication required" });
});

test("expired token and incorrect audience or issuer are rejected", async () => {
  const auth = await getTestAuth();
  const env = await authenticatedEnv();
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    await auth.token({ exp: now - 1 }),
    await auth.token({ aud: ["wrong-audience"] }),
    await auth.token({ iss: "https://other-access.test.invalid" })
  ];

  for (const token of cases) {
    assert.equal((await verifyAccessJwt(request(token), env)).reason, "invalid");
  }
});

test("missing verifier configuration fails closed as unavailable", async () => {
  const auth = await getTestAuth();
  const response = await requireAccess(request(auth.validToken), {});

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Authentication service unavailable" });
});

