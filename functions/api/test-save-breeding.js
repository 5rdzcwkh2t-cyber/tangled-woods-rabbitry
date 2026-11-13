
export async function onRequestPost({ request, env }) {
  const reply = (body, status = 200) =>
    Response.json(body, {
      status,
      headers: { "Cache-Control": "no-store" }
    });

  // Only permit operations in the test environment.
  if (env.TEST_DATABASE !== "tangled-woods-test-db") {
    return reply({ error: "Test environment not configured" }, 403);
  }

  // Require Cloudflare Access authentication.
  if (!request.headers.get("Cf-Access-Jwt-Assertion")) {
    return reply({ error: "Authentication required" }, 401);
  }

  // Reject requests originating from another website.
  if (request.headers.get("Origin") !== new URL(request.url).origin) {
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

    const fields = [
      "doeId",
      "buckId",
      "date",
      "status",
      "kindledDate",
      "notes"
    ];

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof body._id !== "string" ||
      !body._id.startsWith("TEST-BREEDING-") ||
      fields.some(field =>
        typeof body[field] !== "string" ||
        body[field].length > 1000
      )
    ) {
      return reply({ error: "Invalid breeding record" }, 400);
    }

    const validDate = value => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

      const date = new Date(value + "T00:00:00Z");

      return !Number.isNaN(date.getTime()) &&
        date.toISOString().slice(0, 10) === value;
    };

    const allowedStatuses = [
      "Bred",
      "Confirmed pregnant",
      "Kindled",
      "Unsuccessful",
      "Cancelled"
    ];

    if (
      !validDate(body.date) ||
      (body.kindledDate && !validDate(body.kindledDate)) ||
      !allowedStatuses.includes(body.status) ||
      !body.doeId ||
      !body.buckId ||
      body.doeId === body.buckId
    ) {
      return reply({ error: "Invalid breeding details" }, 400);
    }

    // Ensure the breeding already exists.
    const existing = await env.DB.prepare(
      "SELECT data FROM breedings WHERE id = ?"
    ).bind(body._id).first();

    if (!existing) {
      return reply({ error: "Breeding record not found" }, 404);
    }
    const originalBreeding = JSON.parse(existing.data);
    if (
  !originalBreeding ||
  typeof originalBreeding !== "object" ||
  Array.isArray(originalBreeding) ||
  originalBreeding._id !== body._id ||
  typeof originalBreeding.doeId !== "string" ||
  typeof originalBreeding.buckId !== "string"
) {
  return reply({ error: "Invalid existing breeding record" }, 500);
}
    // Verify both parents against the test database.
    for (const [field, sex] of [
      ["doeId", "Doe"],
      ["buckId", "Buck"]
    ]) {
      const id = body[field];

      const record = await env.DB.prepare(
        "SELECT data FROM rabbits WHERE id = ?"
      ).bind(id).first();

      if (!record) {
        return reply({ error: `Selected ${sex} not found` }, 400);
      }

      let rabbit;

      try {
        rabbit = JSON.parse(record.data);
      } catch {
        return reply({ error: `Invalid ${sex} record` }, 400);
      }

      if (
  !rabbit ||
  rabbit._id !== id ||
  String(rabbit.Sex).toLowerCase() !== sex.toLowerCase() ||
  (rabbit.Archived === true && originalBreeding[field] !== id)
) {
  return reply({ error: `Invalid ${sex} selection` }, 400);
}
    }

    

    const breeding = {
      _id: body._id,
      doeId: body.doeId,
      buckId: body.buckId,
      date: body.date,
      status: body.status,
      kindledDate: body.kindledDate,
      notes: body.notes.trim()
    };

    const result = await env.DB.prepare(
      "UPDATE breedings SET data = ? WHERE id = ?"
    ).bind(JSON.stringify(breeding), body._id).run();

    if (result.meta?.changes !== 1) {
      return reply({ error: "Breeding was not updated" }, 500);
    }

    return reply({ updated: true, breeding });

  } catch (error) {
    console.error("Test breeding update failed", error);
    return reply({ error: "Unable to update breeding" }, 500);
  }
}
