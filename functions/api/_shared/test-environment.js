const TEST_DATABASE = "tangled-woods-dev-v2";

const reply = (body, status) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" }
  });

export async function requireTestEnvironment(env) {
  if (env.TEST_DATABASE !== TEST_DATABASE) {
    return reply({ error: "Test environment not configured" }, 403);
  }

  const marker = await env.DB.prepare(
    "SELECT marker FROM test_environment WHERE marker = ?"
  ).bind(TEST_DATABASE).first();

  if (marker?.marker !== TEST_DATABASE) {
    return reply({ error: "Test database verification failed" }, 403);
  }

  return null;
}
