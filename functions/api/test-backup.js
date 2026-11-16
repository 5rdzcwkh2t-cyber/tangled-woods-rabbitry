import { requireAccess } from "./_shared/access-auth.js";

export async function onRequestPost({ request, env }) {
  const reply = (body, status = 200) =>
    Response.json(body, {
      status,
      headers: { "Cache-Control": "no-store" }
    });

  const unauthorized = await requireAccess(request, env);
  if (unauthorized) return unauthorized;

  // Only permit backups in the test environment.
  if (env.TEST_DATABASE !== "tangled-woods-test-db") {
    return reply({ error: "Test environment not configured" }, 403);
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
