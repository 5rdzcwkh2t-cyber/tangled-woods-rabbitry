const issuer = "https://access.test.invalid";
const audience = "tangled-woods-integration-test";
const keyId = "integration-test-key";
let fixturePromise;

function encode(value) {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : new TextEncoder().encode(JSON.stringify(value));
  return Buffer.from(bytes).toString("base64url");
}

async function buildFixture() {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["sign", "verify"]
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  publicJwk.kid = keyId;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  async function token(overrides = {}) {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT", kid: keyId };
    const payload = {
      iss: issuer,
      aud: [audience],
      sub: "integration-test-user",
      iat: now,
      nbf: now - 5,
      exp: now + 300,
      ...overrides
    };
    const signingInput = `${encode(header)}.${encode(payload)}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      new TextEncoder().encode(signingInput)
    );
    return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
  }

  return {
    issuer,
    audience,
    jwks: { keys: [publicJwk] },
    token,
    validToken: await token()
  };
}

export function getTestAuth() {
  fixturePromise ??= buildFixture();
  return fixturePromise;
}

export async function authenticatedEnv(extra = {}) {
  const auth = await getTestAuth();
  return {
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: auth.issuer,
    CLOUDFLARE_ACCESS_AUD: auth.audience,
    CLOUDFLARE_ACCESS_JWKS: auth.jwks,
    ...extra
  };
}

