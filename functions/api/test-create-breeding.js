
export async function onRequestPost({ request, env }) {
  const reply = (body, status = 200) =>
    Response.json(body, {
      status,
      headers: { "Cache-Control": "no-store" }
    });

  // Restrict writes to the designated test environment.
  if (env.TEST_DATABASE !== "tangled-woods-test-db") {
    return reply({ error: "Test environment not configured" }, 403);
  }

  // Require Cloudflare Access authentication.
  if (!request.headers.get("Cf-Access-Jwt-Assertion")) {
    return reply({ error: "Authentication required" }, 401);
  }

  // Only accept requests from our own website.
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

    const keys = [
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
      keys.some(key =>
        typeof body[key] !== "string" ||
        body[key].length > 1000
      )
    ) {
      return reply({ error: "Invalid breeding fields" }, 400);
    }

    const allowedStatuses = [
      "Bred",
      "Confirmed pregnant",
      "Kindled",
      "Unsuccessful",
      "Cancelled"
    ];

    const validDate = value => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const date = new Date(value + "T00:00:00Z");
      return !Number.isNaN(date.getTime()) &&
        date.toISOString().slice(0, 10) === value;
    };

    if (
      !validDate(body.date) ||
      (body.kindledDate &&
        !validDate(body.kindledDate)) ||
      !allowedStatuses.includes(body.status) ||
      !body.doeId ||
      !body.buckId ||
      body.doeId === body.buckId
    ) {
      return reply({ error: "Invalid breeding details" }, 400);
    }

    const parents = {};

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
        rabbit.Archived === true
      ) {
        return reply({ error: `Invalid ${sex} selection` }, 400);
      }

      parents[field] = rabbit.Name;
    }

    const id = "TEST-BREEDING-" + crypto.randomUUID();

    const breeding = {
  _id: id,
  doeId: body.doeId,
  buckId: body.buckId,
  date: body.date,
  status: body.status,
  kindledDate: body.kindledDate,
  notes: body.notes.trim()
};

    const result = await env.DB.prepare(
      "INSERT INTO breedings (id, data) VALUES (?, ?)"
    ).bind(id, JSON.stringify(breeding)).run();

    if (result.meta?.changes !== 1) {
      return reply({ error: "Breeding was not created" }, 500);
    }

    return reply({ created: true, breeding }, 201);

  } catch (error) {
    console.error("Test breeding creation failed", error);
    return reply({ error: "Unable to create test breeding" }, 500);
  }
}
