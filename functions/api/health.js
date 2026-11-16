import { requireAccess } from "./_shared/access-auth.js";

export async function onRequestGet({ request, env }) {
  const unauthorized = await requireAccess(request, env);
  if (unauthorized) return unauthorized;
  try {
    const rabbits = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM rabbits"
    ).first();

    const litters = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM litters"
    ).first();

    return Response.json({
      status: "Database connected",
      rabbits: rabbits.total,
      litters: litters.total
    });
  } catch (error) {
    return Response.json(
      { status: "Connection failed" },
      { status: 500 }
    );
  }
}
