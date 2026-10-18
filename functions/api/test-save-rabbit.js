

export async function onRequestPost({ request, env }) {
  const reply = (body, status = 200) =>
    Response.json(body, {
      status,
      headers: { "Cache-Control": "no-store" }
    });

  // Never allow this test endpoint to run against production.
  if (env.TEST_DATABASE !== "tangled-woods-test-db") {
    return reply({ error: "Test environment not configured" }, 403);
  }

  // Cloudflare Access must have authenticated the request.
  const access = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!access) {
    return reply({ error: "Authentication required" }, 401);
  }

  const origin = request.headers.get("Origin");
  if (origin !== new URL(request.url).origin) {
    return reply({ error: "Invalid request origin" }, 403);
  }

  try {
    const marker = await env.DB.prepare(
  "SELECT marker FROM test_environment WHERE marker = ?"
).bind("tangled-woods-test-db").first();

if (!marker) {
  return reply({ error: "Test database verification failed" }, 403);
}
    const body = await request.json();

    if (
      !body ||
      body._id !== "TEST-001" ||
      typeof body.Name !== "string" ||
      body.Name.trim().length < 1 ||
      body.Name.length > 100
    ) {
      return reply({ error: "Invalid test rabbit" }, 400);
    }

    const existing = await env.DB.prepare(
      "SELECT id FROM rabbits WHERE id = ?"
    ).bind("TEST-001").first();

    if (!existing) {
      return reply({ error: "Test rabbit not found" }, 404);
    }

    const rabbit = {
      _id: "TEST-001",
      Name: body.Name.trim(),
      Sex: "Doe",
      Breed: "Holland Lop",
      Status: "Test"
    };

    await env.DB.prepare(
      "UPDATE rabbits SET name = ?, data = ? WHERE id = ?"
    ).bind(rabbit.Name, JSON.stringify(rabbit), "TEST-001").run();

    return reply({ saved: true, rabbit });
  } catch (error) {
    console.error("Test save failed", error);
    return reply({ error: "Unable to save test rabbit" }, 500);
  }
}
