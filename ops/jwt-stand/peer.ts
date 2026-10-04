// Only the full application's LLM health dependency; no external model/SMS calls.
const server = Bun.serve({ hostname: "0.0.0.0", port: 3100,
  fetch() { return Response.json({ data: [{ id: "synthetic-model" }] }); },
});
async function stop() { await server.stop(false); process.exit(0); }
process.on("SIGTERM", stop); process.on("SIGINT", stop);
