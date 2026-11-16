import { requireAccess } from "./_shared/access-auth.js";

export async function onRequestGet({ request, env }) {
  const reply = (body, status = 200) =>
    Response.json(body, {
      status,
      headers: { "Cache-Control": "no-store" }
    });

  const unauthorized = await requireAccess(request, env);
  if (unauthorized) return unauthorized;

  // Only allow access to our designated test database.
  if (env.TEST_DATABASE !== "tangled-woods-dev-v2") {
    return reply({ error: "Test environment not configured" }, 403);
  }

  try {
    // Verify the test database identity.
    const marker = await env.DB.prepare(
      "SELECT marker FROM test_environment WHERE marker = ?"
    ).bind("tangled-woods-dev-v2").first();

    if (!marker) {
      return reply({ error: "Test database verification failed" }, 403);
    }

    // Retrieve breeding records.
    const { results } = await env.DB.prepare(
      "SELECT data FROM breedings ORDER BY id"
    ).all();

    const breedings = results.map(row => JSON.parse(row.data));

    return reply({ breedings });

  } catch (error) {
    console.error("Breeding records read failed", error);
    return reply({ error: "Unable to load breeding records" }, 500);
  }
}
