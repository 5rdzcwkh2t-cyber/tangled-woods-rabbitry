
export async function onRequestPost({ request, env }) {
  const reply = (body, status = 200) =>
    Response.json(body, {
      status,
      headers: { "Cache-Control": "no-store" }
    });

  if (env.TEST_DATABASE !== "tangled-woods-test-db") {
    return reply({ error: "Test environment not configured" }, 403);
  }

  if (!request.headers.get("Cf-Access-Jwt-Assertion")) {
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
    const keys = [
  "Name", "Dam", "Sire", "DamID", "SireID",
  "Bred", "Born", "Total Kits", "Sold Kits",
  "Died Kits", "Notes"
];

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof body._id !== "string" ||
      !/^TEST-LITTER-[0-9a-f-]{36}$/i.test(body._id) ||
      !body.expected ||
      typeof body.expected !== "object" ||
      Array.isArray(body.expected) ||
      keys.some(key =>
        typeof body[key] !== "string" ||
        body[key].length > 100 ||
        (key === "Name" && !body[key].trim()) ||
        typeof body.expected[key] !== "string"
      )
    ) {
      return reply({ error: "Invalid test litter fields" }, 400);
    }

    const existing = await env.DB.prepare(
      "SELECT data FROM litters WHERE id = ?"
    ).bind(body._id).first();

    if (!existing) {
      return reply({ error: "Test litter not found" }, 404);
    }

    let stored;
    try {
      stored = JSON.parse(existing.data);
    } catch {
      return reply({ error: "Stored litter data is invalid" }, 409);
    }

    if (
      !stored ||
      typeof stored !== "object" ||
      Array.isArray(stored) ||
      stored._id !== body._id
    ) {
      return reply({ error: "Stored litter ID mismatch" }, 409);
    }

    if (keys.some(key =>
  body.expected[key] !== String(stored[key] ?? "")
)) {
      return reply({
        error: "Litter changed since you opened it. Reload before saving."
      }, 409);
    }

// Verify the selected dam and sire against the test rabbit records.
for (const [field, idField, requiredSex] of [
  ["Dam", "DamID", "Doe"],
  ["Sire", "SireID", "Buck"]
]) {
  const parentID = body[idField];

  if (!parentID || !body[field]) {
    return reply({
      error: field + " and its permanent ID are required."
    }, 400);
  }

  const parentRow = await env.DB.prepare(
    "SELECT data FROM rabbits WHERE id = ?"
  ).bind(parentID).first();

  if (!parentRow) {
    return reply({
      error: "Selected " + field + " was not found."
    }, 400);
  }

  let parent;
  try {
    parent = JSON.parse(parentRow.data);
  } catch {
    return reply({
      error: "Selected parent record is invalid."
    }, 409);
  }

  if (
    !parent ||
    parent._id !== parentID ||
    parent.Sex !== requiredSex ||
    
(parent.Archived === true && parentID !== String(stored[idField] ?? "")) ||

    parent.Name !== body[field]
  ) {
    return reply({
      error: "Selected " + field + " does not match a valid rabbit."
    }, 400);
  }
}

    const litter = { ...stored };
    for (const key of keys) {
      litter[key] = body[key].trim();
    }

    const updated = await env.DB.prepare(
      "UPDATE litters SET data = ? WHERE id = ? AND data = ?"
    ).bind(
      JSON.stringify(litter),
      body._id,
      existing.data
    ).run();

    if (updated.meta?.changes !== 1) {
      return reply({
        error: "Litter changed during save. Reload before trying again."
      }, 409);
    }

    return reply({ saved: true, litter });
  } catch (error) {
    console.error("Test litter save failed", error);
    return reply({ error: "Unable to save test litter" }, 500);
  }
}
