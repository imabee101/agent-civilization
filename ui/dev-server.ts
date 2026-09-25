/** Tiny static dev server for the UI only: `bun ui/dev-server.ts` then open http://localhost:5173/?mock=1 */
import index from "./index.html";

const port = Number(process.env.PORT ?? 5173);
Bun.serve({
  port,
  routes: { "/": index },
  development: true,
  fetch() {
    return new Response("not found", { status: 404 });
  },
});
console.log(`ui dev server on http://localhost:${port}/?mock=1`);
