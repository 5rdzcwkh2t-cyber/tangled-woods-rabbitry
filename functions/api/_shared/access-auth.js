const CERT_CACHE_MS = 5 * 60 * 1000;
const certCache = new Map();

const DIAGNOSTIC = Object.freeze({
  missing: "access_jwt_missing_token",
  malformed: "access_jwt_malformed_token",
  algorithm: "access_jwt_unsupported_algorithm",
  jwks: "access_jwt_jwks_fetch_failure",
  key: "access_jwt_signing_key_missing",
  signature: "access_jwt_signature_failure",
  issuer: "access_jwt_issuer_mismatch",
  audience: "access_jwt_audience_mismatch",
  expired: "access_jwt_expired_token",
  notYetValid: "access_jwt_not_yet_valid_token",
  unexpected: "access_jwt_unexpected_verification_error"
});

function reject(reason, code, options) {
  (options.logger || console.warn)(code);
  return { ok: false, reason };
}

function response(body, status) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function configuredIssuer(env) {
  const value = String(env.CLOUDFLARE_ACCESS_TEAM_DOMAIN || "").trim();
  if (!value) return null;
  return (value.startsWith("https://") ? value : `https://${value}`).replace(/\/+$/, "");
}

function configuredAudiences(env) {
  return String(env.CLOUDFLARE_ACCESS_AUD || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
}

function requestToken(request) {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (assertion) return assertion;

  const cookie = (request.headers.get("Cookie") || "")
    .split(";")
    .map(value => value.trim())
    .find(value => value.startsWith("CF_Authorization="));

  return cookie ? cookie.slice("CF_Authorization=".length) : null;
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function decodeJson(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

async function accessKeys(issuer, env, fetcher) {
  // Tests may inject a non-secret JWKS object. Normal Cloudflare environments
  // fetch the public signing certificates from the configured team domain.
  if (env.CLOUDFLARE_ACCESS_JWKS) {
    const jwks = typeof env.CLOUDFLARE_ACCESS_JWKS === "string"
      ? JSON.parse(env.CLOUDFLARE_ACCESS_JWKS)
      : env.CLOUDFLARE_ACCESS_JWKS;
    if (!jwks || !Array.isArray(jwks.keys)) throw new Error("Invalid Access JWKS");
    return jwks.keys;
  }

  const cached = certCache.get(issuer);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;

  const certs = await fetcher(`${issuer}/cdn-cgi/access/certs`, {
    headers: { Accept: "application/json" }
  });
  if (!certs.ok) throw new Error("Access certificate request failed");
  const jwks = await certs.json();
  if (!jwks || !Array.isArray(jwks.keys)) throw new Error("Invalid Access certificate response");

  certCache.set(issuer, {
    keys: jwks.keys,
    expiresAt: Date.now() + CERT_CACHE_MS
  });
  return jwks.keys;
}

export async function verifyAccessJwt(request, env, options = {}) {
  const issuer = configuredIssuer(env);
  const audiences = configuredAudiences(env);
  if (!issuer || audiences.length === 0) return { ok: false, reason: "configuration" };

  const token = requestToken(request);
  if (!token) return reject("missing", DIAGNOSTIC.missing, options);

  try {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some(part => !part)) {
      return reject("invalid", DIAGNOSTIC.malformed, options);
    }

    let header;
    let payload;
    try {
      header = decodeJson(parts[0]);
      payload = decodeJson(parts[1]);
    } catch {
      return reject("invalid", DIAGNOSTIC.malformed, options);
    }
    if (!header || typeof header !== "object" || !payload || typeof payload !== "object" ||
        Array.isArray(header) || Array.isArray(payload) || typeof header.kid !== "string") {
      return reject("invalid", DIAGNOSTIC.malformed, options);
    }
    if (header.alg !== "RS256") {
      return reject("invalid", DIAGNOSTIC.algorithm, options);
    }

    let keys;
    try {
      keys = await accessKeys(issuer, env, options.fetcher || fetch);
    } catch {
      return reject("invalid", DIAGNOSTIC.jwks, options);
    }
    const keyData = keys.find(key => key.kid === header.kid && key.kty === "RSA");
    if (!keyData) return reject("invalid", DIAGNOSTIC.key, options);

    const key = await crypto.subtle.importKey(
      "jwk",
      keyData,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const validSignature = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decodeBase64Url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (!validSignature) return reject("invalid", DIAGNOSTIC.signature, options);

    const now = Math.floor((options.now ?? Date.now()) / 1000);
    const tokenAudiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const validAudience = audiences.some(audience => tokenAudiences.includes(audience));
    if (payload.iss !== issuer) return reject("invalid", DIAGNOSTIC.issuer, options);
    if (!validAudience) return reject("invalid", DIAGNOSTIC.audience, options);
    if (typeof payload.exp !== "number") return reject("invalid", DIAGNOSTIC.malformed, options);
    if (payload.exp <= now) return reject("invalid", DIAGNOSTIC.expired, options);
    if (payload.nbf !== undefined && typeof payload.nbf !== "number") {
      return reject("invalid", DIAGNOSTIC.malformed, options);
    }
    if (payload.nbf > now) return reject("invalid", DIAGNOSTIC.notYetValid, options);

    return { ok: true, payload };
  } catch {
    return reject("invalid", DIAGNOSTIC.unexpected, options);
  }
}

export async function requireAccess(request, env) {
  const result = await verifyAccessJwt(request, env);
  if (result.ok) return null;
  if (result.reason === "configuration") {
    return response({ error: "Authentication service unavailable" }, 503);
  }
  return response({ error: "Authentication required" }, 401);
}

