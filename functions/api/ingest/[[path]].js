import itemsHandler from "./items.js";
import extractHandler from "./extract.js";

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const subpath = url.pathname.replace(/^\/api\/ingest\/?/, "");

  // Normalize
  const route = subpath.split("/")[0];

  switch (route) {
    case "":
    case "items":
      return itemsHandler.onRequest(context);

    case "extract":
      return extractHandler.onRequest(context);

    default:
      return new Response(
        JSON.stringify({ error: "Unknown ingest route", route }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
  }
}
