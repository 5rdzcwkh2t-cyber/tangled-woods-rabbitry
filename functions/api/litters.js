
export async function onRequestGet({ env }) {
  try {
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

