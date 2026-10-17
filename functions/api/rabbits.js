
export async function onRequestGet({ env }) {
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
