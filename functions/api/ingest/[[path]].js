// functions/api/ingest/[[path]].js

import * as items from "./items.js";
import * as extract from "./extract.js";

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const subpath = url.pathname.replace(/^\/api\/ingest\/?/, "");
  const route = (subpath.split("/")[0] || "").toLowerCase();

  // Prefer method-specific handlers when present (Pages convention)
  const method = context.request.method.toUpperCase();

  const dispatch = async (mod) => {
    if (method === "OPTIONS" && mod.onRequestOptions) return mod.onRequestOptions(context);
    if (method === "POST" && mod.onRequestPost) return mod.onRequestPost(context);
    if (mod.onRequest) return mod.onRequest(context);
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  };

  switch (route) {
    case "":
    case "items":
      return dispatch(items);

    case "extract":
      return dispatch(extract);

    default:
      return new Response(JSON.stringify({ error: "Unknown ingest route", route }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
  }
}
