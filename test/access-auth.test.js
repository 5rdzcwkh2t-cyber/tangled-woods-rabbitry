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

function replaceHeader(token, header) {
  const parts = token.split(".");
  parts[0] = Buffer.from(JSON.stringify(header)).toString("base64url");
  return parts.join(".");
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
  const tokenParts = auth.validToken.split(".");
  tokenParts[2] = (tokenParts[2][0] === "A" ? "B" : "A") + tokenParts[2].slice(1);
  const forged = tokenParts.join(".");

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

test("JWT failures emit only fixed safe diagnostic categories", async () => {
  const auth = await getTestAuth();
  const env = await authenticatedEnv();
  const header = JSON.parse(Buffer.from(auth.validToken.split(".")[0], "base64url").toString());
  const now = Math.floor(Date.now() / 1000);
  const forgedParts = auth.validToken.split(".");
  forgedParts[2] = (forgedParts[2][0] === "A" ? "B" : "A") + forgedParts[2].slice(1);

  const cases = [
    ["access_jwt_missing_token", request(null), env, {}],
    ["access_jwt_malformed_token", request("not-a-jwt"), env, {}],
    ["access_jwt_unsupported_algorithm", request(replaceHeader(auth.validToken, {
      ...header, alg: "none"
    })), env, {}],
    ["access_jwt_jwks_fetch_failure", request(auth.validToken), {
      CLOUDFLARE_ACCESS_TEAM_DOMAIN: auth.issuer,
      CLOUDFLARE_ACCESS_AUD: auth.audience
    }, { fetcher: async () => { throw new Error("sensitive fetch detail"); } }],
    ["access_jwt_signing_key_missing", request(auth.validToken), {
      ...env, CLOUDFLARE_ACCESS_JWKS: { keys: [] }
    }, {}],
    ["access_jwt_signature_failure", request(forgedParts.join(".")), env, {}],
    ["access_jwt_issuer_mismatch", request(await auth.token({
      iss: "https://private-issuer.example.invalid"
    })), env, {}],
    ["access_jwt_audience_mismatch", request(await auth.token({
      aud: ["private-audience-value"]
    })), env, {}],
    ["access_jwt_expired_token", request(await auth.token({ exp: now - 1 })), env, {}],
    ["access_jwt_not_yet_valid_token", request(await auth.token({ nbf: now + 300 })), env, {}],
    ["access_jwt_unexpected_verification_error", request(auth.validToken), {
      ...env, CLOUDFLARE_ACCESS_JWKS: { keys: [{ kty: "RSA", kid: header.kid }] }
    }, {}]
  ];

  const emitted = [];
  for (const [expected, input, caseEnv, options] of cases) {
    const result = await verifyAccessJwt(input, caseEnv, {
      ...options,
      logger: code => emitted.push(code)
    });
    assert.equal(result.ok, false);
    assert.equal(emitted.at(-1), expected);
  }

  assert.deepEqual(emitted, cases.map(([expected]) => expected));
  const output = JSON.stringify(emitted);
  for (const sensitive of [
    auth.validToken, auth.issuer, auth.audience, "private-issuer",
    "private-audience", "integration-test-user", "sensitive fetch detail"
  ]) {
    assert.doesNotMatch(output, new RegExp(sensitive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

