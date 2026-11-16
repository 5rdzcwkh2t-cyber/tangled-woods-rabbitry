import { requireAccess } from "./_shared/access-auth.js";
import { requireTestEnvironment } from "./_shared/test-environment.js";

export async function onRequestGet({ request, env }) {
  const reply = (body, status = 200) =>
    Response.json(body, {
      status,
      headers: { "Cache-Control": "no-store" }
    });

  const unauthorized = await requireAccess(request, env);
  if (unauthorized) return unauthorized;

  try {
    const invalidEnvironment = await requireTestEnvironment(env);
    if (invalidEnvironment) return invalidEnvironment;

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
