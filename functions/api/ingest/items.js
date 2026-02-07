// Cost control
const VISION_ENABLED = false; // flip to true when you're ready / funded

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function sha256Hex(arrayBuffer) {
  const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function onRequestPost({ request, env }) {
  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return json({ ok: false, error: "Expected multipart/form-data" }, 400);
    }

    const form = await request.formData();

    // Your UI sends files as "files"
    const files = form.getAll("files").filter(Boolean);

    if (!files.length) {
      return json(
        { ok: false, error: "No files received. Field name must be 'files'." },
        400
      );
    }

    // Keep this small while you're iterating
    const MAX_FILES = 10;

    const out = [];
    const imagesForVision = [];

    for (const [i, f] of files.slice(0, MAX_FILES).entries()) {
      const buf = await f.arrayBuffer();
      const hash = await sha256Hex(buf);

      out.push({
        slot: i + 1,
        name: f.name || "unnamed",
        type: f.type || "application/octet-stream",
        size_bytes: buf.byteLength,
        sha256: hash,
      });

      // Only attempt vision for image-like inputs
      const mime = f.type || "";
      if (mime.startsWith("image/")) {
        const b64 = arrayBufferToBase64(buf);
        imagesForVision.push({
          slot: i + 1,
          dataUrl: `data:${mime};base64,${b64}`,
        });
      }
    }

    const mode = form.get("mode") || "default";

    // Default: do NOT call OpenAI (cost control)
    let analysis = {
      ok: false,
      image_count: imagesForVision.length,
      mode,
      verdict: "uncertain",
      confidence: 0,
      reason:
        VISION_ENABLED
          ? "Vision available but not requested (set mode=vision)."
          : "Vision disabled (cost control).",
      items: imagesForVision.map((img) => ({
        slot: img.slot,
        item_kind: "unknown",
        name: null,
        manufacturer: null,
        level: null,
        dps: null,
        damage: null,
        rarity: null,
        elements: ["unknown"],
        notes: [VISION_ENABLED ? "Set mode=vision to analyze." : "Vision disabled."],
        confidence: 0,
      })),
    };

    // Only call OpenAI if:
    // 1) VISION_ENABLED is true, AND
    // 2) mode is exactly "vision"
    if (VISION_ENABLED && mode === "vision") {
      analysis = await analyzeWithDuumGPT({
        env,
        images: imagesForVision,
        mode,
      });
    }

    return json({
      ok: true,
      received_count: out.length,
      files: out,
      vision_image_count: imagesForVision.length,
      analysis,
    });
  } catch (err) {
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
}

/** ---- OpenAI Vision + Structured JSON ---- */

const DUUM_INGEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    image_count: { type: "integer" },
    mode: { type: "string" },

    verdict: {
      type: "string",
      enum: ["weapon_screenshot", "borderlands_non_item", "not_borderlands", "uncertain"],
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },

    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          slot: { type: "integer" },
          item_kind: {
            type: "string",
            enum: ["weapon", "shield", "ordnance", "class_mod", "enhancement", "artifact", "other", "unknown"],
          },
          name: { anyOf: [{ type: "string" }, { type: "null" }] },
          manufacturer: { anyOf: [{ type: "string" }, { type: "null" }] },
          level: { anyOf: [{ type: "integer" }, { type: "null" }] },
          dps: { anyOf: [{ type: "number" }, { type: "null" }] },
          damage: { anyOf: [{ type: "string" }, { type: "null" }] },
          rarity: { anyOf: [{ type: "string" }, { type: "null" }] },
          elements: {
            type: "array",
            items: {
              type: "string",
              enum: ["incendiary", "corrosive", "cryo", "shock", "radiation", "none", "unknown"],
            },
          },
          notes: { type: "array", items: { type: "string" } },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: [
          "slot",
          "item_kind",
          "name",
          "manufacturer",
          "level",
          "dps",
          "damage",
          "rarity",
          "elements",
          "notes",
          "confidence",
        ],
      },
    },
  },
  required: ["ok", "image_count", "mode", "verdict", "confidence", "reason", "items"],
};

async function analyzeWithDuumGPT({ env, images, mode }) {
  const apiKey = env?.OPENAI_API_KEY;
  const model = env?.OPENAI_MODEL || "gpt-4o-2024-08-06";

  if (!apiKey) {
    return {
      ok: false,
      image_count: images.length,
      mode,
      verdict: "uncertain",
      confidence: 0,
      reason: "OPENAI_API_KEY is not set in Cloudflare environment variables.",
      items: images.map((img) => ({
        slot: img.slot,
        item_kind: "unknown",
        name: null,
        manufacturer: null,
        level: null,
        dps: null,
        damage: null,
        rarity: null,
        elements: ["unknown"],
        notes: ["Missing OPENAI_API_KEY."],
        confidence: 0,
      })),
    };
  }

  if (!images.length) {
    return {
      ok: false,
      image_count: 0,
      mode,
      verdict: "uncertain",
      confidence: 0,
      reason: "No image/* files were provided.",
      items: [],
    };
  }

  const userContent = [
    {
      type: "input_text",
      text:
        `You are DuumGPT. Analyze Borderlands 4 item screenshots/photos.\n` +
        `Rules:\n` +
        `- Return null for any field you cannot read. Do NOT guess.\n` +
        `- If an image is not a BL4 item screen, set item_kind="unknown" and add a note.\n` +
        `- "verdict" is for the batch; "items" is per image.\n` +
        `Mode: ${mode}`,
    },
    ...images.map((img) => ({
      type: "input_image",
      image_url: img.dataUrl,
    })),
  ];

  const payload = {
    model,
    input: [
      {
        role: "user",
        content: userContent,
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "duum_ingest_items",
        strict: true,
        schema: DUUM_INGEST_SCHEMA,
      },
    },
    max_output_tokens: 450, // lower = cheaper
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    return {
      ok: false,
      image_count: images.length,
      mode,
      verdict: "uncertain",
      confidence: 0,
      reason: `OpenAI API error ${resp.status}: ${errText.slice(0, 500)}`,
      items: images.map((img) => ({
        slot: img.slot,
        item_kind: "unknown",
        name: null,
        manufacturer: null,
        level: null,
        dps: null,
        damage: null,
        rarity: null,
        elements: ["unknown"],
        notes: ["OpenAI API call failed."],
        confidence: 0,
      })),
    };
  }

  const data = await resp.json();
  const raw = data.output_text;

  try {
    return JSON.parse(raw);
  } catch {
    return {
      ok: false,
      image_count: images.length,
      mode,
      verdict: "uncertain",
      confidence: 0,
      reason: "Model returned non-JSON output unexpectedly.",
      items: images.map((img) => ({
        slot: img.slot,
        item_kind: "unknown",
        name: null,
        manufacturer: null,
        level: null,
        dps: null,
        damage: null,
        rarity: null,
        elements: ["unknown"],
        notes: ["Non-JSON output from model."],
        confidence: 0,
      })),
    };
  }
}

/** ---- tiny utilities ---- */

// Worker-safe base64: no spread args, no giant call stacks
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    for (let j = 0; j < chunk.length; j++) {
      binary += String.fromCharCode(chunk[j]);
    }
  }
  return btoa(binary);
}
