export async function onRequestGet({ env }) {
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
