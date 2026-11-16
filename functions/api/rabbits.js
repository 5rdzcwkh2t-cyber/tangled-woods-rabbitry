
import { requireAccess } from "./_shared/access-auth.js";

export async function onRequestGet({ request, env }) {
  const unauthorized = await requireAccess(request, env);
  if (unauthorized) return unauthorized;
  try {
    const { results } = await env.DB.prepare(
      "SELECT data FROM rabbits ORDER BY id"
    ).all();

    const rabbits = results.map((row) => JSON.parse(row.data));

    return Response.json(
      { rabbits },
      {
        headers: {
          "Cache-Control": "no-store"
        }
      }
    );
  } catch (error) {
    console.error("Rabbit records read failed", error);

    return Response.json(
      { error: "Unable to load rabbit records" },
      { status: 500 }
    );
  }
}
