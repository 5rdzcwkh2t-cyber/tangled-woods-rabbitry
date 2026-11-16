
import { requireAccess } from "./_shared/access-auth.js";
import { requireTestEnvironment } from "./_shared/test-environment.js";

export async function onRequestGet({ request, env }) {
  const unauthorized = await requireAccess(request, env);
  if (unauthorized) return unauthorized;
  try {
    const invalidEnvironment = await requireTestEnvironment(env);
    if (invalidEnvironment) return invalidEnvironment;

    const { results } = await env.DB.prepare(
      "SELECT data FROM litters ORDER BY id"
    ).all();

    const litters = results.map(row => JSON.parse(row.data));

    return Response.json(
      { litters },
      {
        headers: {
          "Cache-Control": "no-store"
        }
      }
    );
  } catch (error) {
    console.error("Litter records read failed", error);

    return Response.json(
      { error: "Unable to load litter records" },
      { status: 500 }
    );
  }
}

