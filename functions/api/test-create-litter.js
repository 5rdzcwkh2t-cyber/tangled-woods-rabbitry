

export async function onRequestPost({ request, env }) {
  const reply = (body, status = 200) =>
    Response.json(body, {
      status,
      headers: { "Cache-Control": "no-store" }
    });

  // Never allow this endpoint outside our test environment.
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
    // Verify that the database is our designated test database.
    const marker = await env.DB.prepare(
      "SELECT marker FROM test_environment WHERE marker = ?"
    ).bind("tangled-woods-test-db").first();

    if (!marker) {
      return reply({ error: "Test database verification failed" }, 403);
    }

    const body = await request.json();

    const keys = [
      "Prefix",
      "Name",
      "Breed",
      "Father",
      "Mother",
      "Bred",
      "Born",
      "Total Kits",
      "Sold Kits",
      "Died Kits",
      "Notes"
    ];

    // Validate all 11 fields.
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
      return reply({ error: "Invalid litter fields" }, 400);
    }

    // Use a unique ID to avoid overwriting existing records.
    const id = "TEST-LITTER-" + crypto.randomUUID();

    const litter = { _id: id };

    for (const key of keys) {
      litter[key] = body[key].trim();
    }

    // Insert a NEW litter record.
    const result = await env.DB.prepare(
      "INSERT INTO litters (id, data) VALUES (?, ?)"
    ).bind(
      id,
      JSON.stringify(litter)
    ).run();

    if (result.meta?.changes !== 1) {
      return reply({ error: "Litter was not created" }, 500);
    }

    return reply({ created: true, litter }, 201);

  } catch (error) {
    console.error("Test litter creation failed", error);
    return reply({ error: "Unable to create test litter" }, 500);
  }
}
