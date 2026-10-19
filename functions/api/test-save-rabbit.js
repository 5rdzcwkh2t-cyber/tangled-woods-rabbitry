
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
    const keys = ["Name", "Sex", "Breed", "Status"];

    if (!body || body._id !== "TEST-001" ||
        !body.expected || typeof body.expected !== "object" ||
        keys.some(key => typeof body[key] !== "string" ||
          body[key].length > 100 ||
          (key === "Name" && !body[key].trim()))) {
      return reply({ error: "Invalid test rabbit fields" }, 400);
    }

    const existing = await env.DB.prepare(
      "SELECT id, name, data FROM rabbits WHERE id = ?"
    ).bind("TEST-001").first();

    if (!existing) {
      return reply({ error: "Test rabbit not found" }, 404);
    }

    let stored;
    try {
      stored = JSON.parse(existing.data);
    } catch {
      return reply({ error: "Stored rabbit data is invalid" }, 409);
    }

    if (!stored || typeof stored !== "object" ||
        Array.isArray(stored) || stored._id !== "TEST-001") {
      return reply({ error: "Stored test rabbit ID mismatch" }, 409);
    }

    // Prevent overwriting changes made by another session.
    if (keys.some(key =>
        typeof body.expected[key] !== "string" ||
        body.expected[key] !== (stored[key] || ""))) {
      return reply({
        error: "Rabbit changed since you opened it. Reload before saving."
      }, 409);
    }

    // Preserve all other existing rabbit fields.
    const rabbit = { ...stored };
    for (const key of keys) {
      rabbit[key] = body[key].trim();
    }

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
    console.error("Test save failed", error);
    return reply({ error: "Unable to save test rabbit" }, 500);
  }
}
