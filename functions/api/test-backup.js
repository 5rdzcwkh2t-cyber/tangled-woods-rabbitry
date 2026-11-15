
const ACCESS_TEAM_DOMAIN = "red-tree-a71a.cloudflareaccess.com";
const ACCESS_AUD = "155af5f22e02d037f8bda482d01c906aa49d6d7fd6a7d09e7245b4435234fe61";

async function verifyAccessToken(request) {
  
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");

  const cookies = request.headers.get("Cookie") || "";
  const accessCookie = cookies.split(";")
    .map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith("CF_Authorization="));

  const token = assertion ||
    (accessCookie ? accessCookie.substring("CF_Authorization=".length) : null);

  if (!token) return false;


  try {
    const issuer = `https://${ACCESS_TEAM_DOMAIN}`;
    const response = await fetch(`${issuer}/cdn-cgi/access/certs`);
    if (!response.ok) return false;

    const { keys } = await response.json();
    const parts = token.split(".");
    if (parts.length !== 3) return false;

    const decode = value => {
      const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(base64);
      return Uint8Array.from(binary, c => c.charCodeAt(0));
    };

    const header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(decode(parts[1])));

    if (header.alg !== "RS256") return false;

    const keyData = keys.find(key => key.kid === header.kid);
    if (!keyData) return false;

    const key = await crypto.subtle.importKey(
      "jwk",
      keyData,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decode(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );

    const now = Math.floor(Date.now() / 1000);

    return valid &&
      payload.iss === issuer &&
      Array.isArray(payload.aud) &&
      payload.aud.includes(ACCESS_AUD) &&
      typeof payload.exp === "number" &&
      payload.exp > now &&
      typeof payload.nbf === "number" &&
      payload.nbf <= now;
  } catch (error) {
    console.error("Access token verification failed", error);
    return false;
  }
}

export async function onRequestPost({ request, env }) {
  const reply = (body, status = 200) =>
    Response.json(body, {
      status,
      headers: { "Cache-Control": "no-store" }
    });

  // Only permit backups in the test environment.
  if (env.TEST_DATABASE !== "tangled-woods-test-db") {
    return reply({ error: "Test environment not configured" }, 403);
  }

  // Reject requests without a valid Cloudflare Access token.
  if (!(await verifyAccessToken(request))) {
    return reply({ error: "Authentication required" }, 401);
  }

  // Only accept requests from our own website.
  const origin = request.headers.get("Origin");
  if (origin !== new URL(request.url).origin) {
    return reply({ error: "Invalid request origin" }, 403);
  }


  // Verify that the bound database is our test database.
  try {
    const marker = await env.DB.prepare(
      "SELECT marker FROM test_environment WHERE marker = ?"
    ).bind("tangled-woods-test-db").first();

    if (!marker) {
      return reply({ error: "Test database verification failed" }, 403);
    }
  } catch (error) {
    console.error("Backup environment verification failed", error);
    return reply({ error: "Database verification failed" }, 500);
  }

  // No backup writes are enabled yet.
  return reply({ status: "Backup endpoint ready; writes disabled" });
}
