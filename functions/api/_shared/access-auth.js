const CERT_CACHE_MS = 5 * 60 * 1000;
const certCache = new Map();

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
  if (!token) return { ok: false, reason: "missing" };

  try {
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, reason: "invalid" };

    const header = decodeJson(parts[0]);
    const payload = decodeJson(parts[1]);
    if (header.alg !== "RS256" || typeof header.kid !== "string") {
      return { ok: false, reason: "invalid" };
    }

    const keys = await accessKeys(issuer, env, options.fetcher || fetch);
    const keyData = keys.find(key => key.kid === header.kid && key.kty === "RSA");
    if (!keyData) return { ok: false, reason: "invalid" };

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

    const now = Math.floor((options.now ?? Date.now()) / 1000);
    const tokenAudiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const validAudience = audiences.some(audience => tokenAudiences.includes(audience));

    if (
      !validSignature ||
      payload.iss !== issuer ||
      !validAudience ||
      typeof payload.exp !== "number" ||
      payload.exp <= now ||
      (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf > now))
    ) {
      return { ok: false, reason: "invalid" };
    }

    return { ok: true, payload };
  } catch {
    return { ok: false, reason: "invalid" };
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

