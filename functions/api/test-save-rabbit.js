
export async function onRequestPost({ request, env }) {
  const reply = (body, status = 200) =>
    Response.json(body, {
      status,
      headers: { "Cache-Control": "no-store" }
    });

  // This endpoint must only work in our test environment.
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
      "SELECT id, name, data FROM rabbits WHERE id = ?"
    ).bind("TEST-001").first();

    if (!existing) {
      return reply({ error: "Test rabbit not found" }, 404);
    }

    // Keep every existing field, changing only the name.
    let stored;
    try {
      stored = JSON.parse(existing.data);
    } catch {
      return reply({ error: "Stored rabbit data is invalid" }, 409);
    }

    if (
      !stored ||
      typeof stored !== "object" ||
      Array.isArray(stored) ||
      stored._id !== "TEST-001"
    ) {
      return reply({ error: "Stored test rabbit ID mismatch" }, 409);
    }

    if (
      typeof body.expectedName === "string" &&
      body.expectedName !== stored.Name
    ) {
      return reply({
        error: "Rabbit changed since you opened it. Reload before saving."
      }, 409);
    }

    const rabbit = { ...stored, Name: body.Name.trim() };

    const updated = await env.DB.prepare(
      "UPDATE rabbits SET name = ?, data = ? WHERE id = ? AND data = ?"
    ).bind(
      rabbit.Name,
      JSON.stringify(rabbit),
      "TEST-001",
      existing.data
    ).run();

    if (updated.meta?.changes !== 1) {
      return reply({
        error: "Rabbit changed during save. Reload before trying again."
      }, 409);
    }

    return reply({ saved: true, rabbit });

  } catch (error) {
    return reply({ error: "Unable to save test rabbit" }, 500);
  }
}
