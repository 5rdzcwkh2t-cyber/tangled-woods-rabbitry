

export async function onRequestPost({ request, env }) {
  const reply = (body, status = 200) =>
    Response.json(body, {
      status,
      headers: { "Cache-Control": "no-store" }
    });

  // Only allow this endpoint in the test environment.
  if (env.TEST_DATABASE !== "tangled-woods-test-db") {
    return reply({ error: "Test environment not configured" }, 403);
  }

  // Require Cloudflare Access authentication.
  const access = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!access) {
    return reply({ error: "Authentication required" }, 401);
  }

  // Only accept requests from our own website.
  const origin = request.headers.get("Origin");
  if (origin !== new URL(request.url).origin) {
    return reply({ error: "Invalid request origin" }, 403);
  }

  try {
    // Verify that DB points to the test database.
    const marker = await env.DB.prepare(
      "SELECT marker FROM test_environment WHERE marker = ?"
    ).bind("tangled-woods-test-db").first();

    if (!marker) {
      return reply({ error: "Test database verification failed" }, 403);
    }

    const body = await request.json();
    const keys = ["Name", "Sex", "Breed", "Status"];

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      keys.some(key =>
        typeof body[key] !== "string" ||
        body[key].length > 100 ||
        (key === "Name" && !body[key].trim())
      )
    ) {
      return reply({ error: "Invalid rabbit fields" }, 400);
    }

    const sex = body.Sex.trim();
    if (!["Buck", "Doe"].includes(sex)) {
      return reply({ error: "Sex must be Buck or Doe" }, 400);
    }

    // Generate a unique ID for the new test rabbit.
    const id = "TEST-" + crypto.randomUUID();

    const rabbit = {
      _id: id,
      Name: body.Name.trim(),
      Sex: sex,
      Breed: body.Breed.trim(),
      Status: body.Status.trim()
    };

    // Insert a NEW record. Never overwrite an existing rabbit.
    const result = await env.DB.prepare(
      "INSERT INTO rabbits (id, name, sex, data) VALUES (?, ?, ?, ?)"
    ).bind(
      id,
      rabbit.Name,
      rabbit.Sex,
      JSON.stringify(rabbit)
    ).run();

    if (result.meta?.changes !== 1) {
      return reply({ error: "Rabbit was not created" }, 500);
    }

    return reply({ created: true, rabbit }, 201);

  } catch (error) {
    console.error("Test rabbit creation failed", error);
    return reply({ error: "Unable to create test rabbit" }, 500);
  }
}
