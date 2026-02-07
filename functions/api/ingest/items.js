export async function onRequestPost({ request }) {
  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return json({ ok: false, error: "Expected multipart/form-data" }, 400);
    }

    const form = await request.formData();

    // Your UI will send files as "files"
    const files = form.getAll("files").filter(Boolean);

    if (!files.length) {
      return json(
        { ok: false, error: "No files received. Field name must be 'files'." },
        400
      );
    }

    const out = [];
    for (const f of files) {
      const buf = await f.arrayBuffer();
      const hash = await sha256Hex(buf);

      out.push({
        name: f.name || "unnamed",
        type: f.type || "application/octet-stream",
        size_bytes: buf.byteLength,
        sha256: hash
      });
    }

    return json({
      ok: true,
      received_count: out.length,
      files: out,
      note: "Ingestion works. Next step is extraction/OCR."
    });
  } catch (err) {
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

async function sha256Hex(arrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
