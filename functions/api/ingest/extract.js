// functions/api/ingest/extract.js
import { postToDuumProposal } from "./post_to_duum.js";

function cors(origin) {
  // Add any other frontends you use here
  const allow = new Set([
    "https://duum.io",
    "https://app.duum.io",
  ]);

  const o = allow.has(origin) ? origin : "https://duum.io";

  return {
    "Access-Control-Allow-Origin": origin ? o : "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status = 200, origin = null) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

async function onRequest(context) {
  const { request, env } = context;
  const origin = request.headers.get("Origin");

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: cors(origin) });
  }
  if (request.method !== "POST") {
    return json({ error: "Use POST" }, 405, origin);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Bad JSON" }, 400, origin);
  }

  const images = Array.isArray(body?.images) ? body.images.slice(0, 3) : [];
  if (!images.length) {
    return json({ error: "No images provided" }, 400, origin);
  }

  // Guardrails
  for (const img of images) {
    const s = String(img || "");
    if (!s.startsWith("data:image/")) {
      return json({ error: "Images must be data URLs (data:image/...)" }, 400, origin);
    }
    // rough ~3MB-ish base64 limit
    if (s.length > 4_500_000) {
      return json({ error: "Image payload too large. Crop/compress and try again." }, 413, origin);
    }
  }

  const system = env.DUUM_SYSTEM_PROMPT || "You are Duum OCR.";

  const prompt = `
You are Duum OCR Extraction.
Convert Borderlands 4 screenshot(s) into a Duum Core proposal.

Return ONLY valid JSON (no markdown, no commentary), with EXACTLY this shape:
{
  "kind": "duum.ocr.proposal.v1",
  "confidence": 0.0-1.0,
  "patch": { },
  "needs_review": [],
  "source": { "service": "duum-app-portal", "images": ${images.length} }
}

Rules:
- If unsure about a field, omit it and add a needs_review entry like "equipped.weapons[0].name".
- Keep patch minimal (only what you’re confident changed or can be read).
- Prefer nested structure like:
  patch.equipped.weapons[], patch.equipped.shield, patch.equipped.class_mod, patch.skills, etc.
`.trim();

  const input = [
    { role: "system", content: system + "\nReturn ONLY JSON." },
    {
      role: "user",
      content: [
        { type: "input_text", text: prompt },
        ...images.map((dataUrl) => ({
          type: "input_image",
          image_url: String(dataUrl),
          detail: "auto",
        })),
      ],
    },
  ];

  // Call OpenAI Responses API
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input,
      max_output_tokens: 900,
    }),
  });

  const raw = await resp.text();
  if (!resp.ok) {
    return json(
      { error: `OpenAI error ${resp.status}`, detail: raw.slice(0, 2000) },
      502,
      origin
    );
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return json({ error: "Bad OpenAI JSON", detail: raw.slice(0, 1200) }, 502, origin);
  }

  const text =
    data.output_text ||
    (data.output?.map(o => o?.content?.map(c => c?.text).join("")).join("\n") ?? "");

  let proposal;
  try {
    proposal = JSON.parse(text);
  } catch {
    return json(
      { error: "Model did not return valid JSON proposal", detail: text.slice(0, 2000) },
      502,
      origin
    );
  }

  // Normalize required fields (just in case)
  if (!proposal.kind) proposal.kind = "duum.ocr.proposal.v1";
  if (typeof proposal.confidence !== "number") proposal.confidence = 0.5;
  if (!proposal.patch || typeof proposal.patch !== "object") proposal.patch = {};
  if (!Array.isArray(proposal.needs_review)) proposal.needs_review = [];
  if (!proposal.source || typeof proposal.source !== "object") {
    proposal.source = { service: "duum-app-portal", images: images.length };
  }

  // Post proposal to Duum Core
  try {
    const posted = await postToDuumProposal(proposal, env);
    return json({ ok: true, proposal, duum: posted }, 200, origin);
  } catch (e) {
    return json({ ok: false, error: String(e), proposal }, 502, origin);
  }
}

export default { onRequest };
