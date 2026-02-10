// Cost control
const VISION_ENABLED = false; // flip to true when you're ready / funded
const uncachedImages = imagesForVision
  .filter((img) => !cachedMap.has(img.sha256))
  .slice(0, 1); // guardrail: only analyze 1 new image per request

function imagesForVision(images) {
  const arr = Array.isArray(images) ? images : [];
  return arr
    .slice(0, 3)
    .map((img) => String(img || ""))
    .filter((s) => s.startsWith("data:image/"))
    .map((dataUrl) => ({
      type: "input_image",
      image_url: dataUrl,
      detail: "auto",
    }));
}

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

function nowIso() {
  return new Date().toISOString();
}

function kvAvailable(env) {
  return !!env?.DUUM_KV && typeof env.DUUM_KV.get === "function" && typeof env.DUUM_KV.put === "function";
}

function cacheKeyForImage(hash) {
  return `img:${hash}`;
}

function normalizeItemForSchema(item, slot) {
  // Ensure the per-item object matches your schema shape exactly.
  // Do not guess fields; default to null/unknown appropriately.
  return {
    slot: Number.isFinite(slot) ? slot : (item?.slot ?? null),
    item_kind: item?.item_kind ?? "unknown",
    name: item?.name ?? null,
    manufacturer: item?.manufacturer ?? null,
    level: item?.level ?? null,
    dps: item?.dps ?? null,
    damage: item?.damage ?? null,
    rarity: item?.rarity ?? null,
    elements: Array.isArray(item?.elements) && item.elements.length ? item.elements : ["unknown"],
    notes: Array.isArray(item?.notes) ? item.notes : [],
    confidence: typeof item?.confidence === "number" ? item.confidence : 0,
  };
}

function buildBatchFromItems({ mode, items, verdict = "uncertain", reason = "", ok = true, confidence = 0 }) {
  return {
    ok,
    image_count: items.length,
    mode,
    verdict,
    confidence,
    reason,
    items,
  };
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

    // NEW: keep hashes aligned with slots
    const slots = []; // [{ slot, sha256, mime, name }]
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

      const mime = f.type || "";
      slots.push({ slot: i + 1, sha256: hash, mime, name: f.name || "unnamed" });

      // Only attempt vision for image-like inputs
      if (mime.startsWith("image/")) {
        const b64 = arrayBufferToBase64(buf);
        imagesForVision.push({
          slot: i + 1,
          sha256: hash,
          dataUrl: `data:${mime};base64,${b64}`,
        });
      }
    }

    const mode = form.get("mode") || "default";

    // ---------- KV CACHE LOOKUP (per image) ----------
    const useKv = kvAvailable(env);

    // We only *need* vision if mode==="vision" AND feature enabled.
    const visionRequested = (mode === "vision");
    const canUseVision = (VISION_ENABLED && visionRequested);

    // If KV is present, try to load cached results for each image hash.
    // Cache stores per-image results, not whole batch.
    const cachedMap = new Map(); // sha256 -> cachedItem
    if (useKv) {
      const gets = await Promise.all(
        imagesForVision.map((img) => env.DUUM_KV.get(cacheKeyForImage(img.sha256), { type: "json" }))
      );

      for (let idx = 0; idx < imagesForVision.length; idx++) {
        const img = imagesForVision[idx];
        const cached = gets[idx];
        if (cached && typeof cached === "object" && cached.item) {
          cachedMap.set(img.sha256, cached.item);
        }
      }
    }

    // Build initial items list: cached where available, otherwise placeholders.
    const itemsInitial = imagesForVision.map((img) => {
      const cachedItem = cachedMap.get(img.sha256);
      if (cachedItem) {
        const normalized = normalizeItemForSchema(cachedItem, img.slot);
        normalized.notes = [
          ...(normalized.notes || []),
          `Cache hit (${img.sha256.slice(0, 8)}…).`,
        ];
        return normalized;
      }

      return {
        slot: img.slot,
        item_kind: "unknown",
        name: null,
        manufacturer: null,
        level: null,
        dps: null,
        damage: null,
        rarity: null,
        elements: ["unknown"],
        notes: [
          useKv ? `Cache miss (${img.sha256.slice(0, 8)}…).` : "KV cache not configured.",
          canUseVision ? "Queued for vision." : (VISION_ENABLED ? "Set mode=vision to analyze." : "Vision disabled."),
        ],
        confidence: 0,
      };
    });

    // Default analysis (no paid call)
    let analysis = buildBatchFromItems({
      mode,
      items: itemsInitial,
      verdict: "uncertain",
      confidence: 0,
      ok: false,
      reason: canUseVision
        ? "Vision requested. Running analysis (uncached images only)."
        : (VISION_ENABLED
            ? (visionRequested ? "Vision requested but disabled by feature flag." : "Vision available but not requested (set mode=vision).")
            : "Vision disabled (cost control)."),
    });

    // ---------- VISION RUN (ONLY IF ENABLED + REQUESTED) ----------
    // Also: only send *uncached* images to OpenAI.
    if (canUseVision) {
      const uncachedImages = imagesForVision.filter((img) => !cachedMap.has(img.sha256));

      if (uncachedImages.length === 0) {
        // Everything came from cache — promote batch to ok:true
        analysis = buildBatchFromItems({
          mode,
          items: itemsInitial,
          verdict: "uncertain",
          confidence: 0,
          ok: true,
          reason: "All images served from cache. No OpenAI call made.",
        });
      } else {
        // Run OpenAI only for uncached images
        const fresh = await analyzeWithDuumGPT({
          env,
          images: uncachedImages,
          mode,
        });

        // Merge fresh results into the full item list by slot.
        const freshBySlot = new Map();
        if (fresh && Array.isArray(fresh.items)) {
          for (const it of fresh.items) {
            if (it && typeof it.slot === "number") freshBySlot.set(it.slot, it);
          }
        }

        const mergedItems = imagesForVision.map((img) => {
          const cachedItem = cachedMap.get(img.sha256);
          if (cachedItem) {
            return normalizeItemForSchema(cachedItem, img.slot);
          }
          const freshItem = freshBySlot.get(img.slot);
          if (freshItem) {
            const normalized = normalizeItemForSchema(freshItem, img.slot);
            normalized.notes = [
              ...(normalized.notes || []),
              `Fresh analysis (${img.sha256.slice(0, 8)}…).`,
            ];
            return normalized;
          }
          // If model omitted something, keep placeholder
          return itemsInitial.find((x) => x.slot === img.slot) || normalizeItemForSchema({}, img.slot);
        });

        // Write fresh results to KV (per image) so we never pay twice
        if (useKv && freshBySlot.size) {
          const puts = [];
          for (const img of uncachedImages) {
            const it = freshBySlot.get(img.slot);
            if (!it) continue;
            const normalized = normalizeItemForSchema(it, img.slot);
            puts.push(
              env.DUUM_KV.put(
                cacheKeyForImage(img.sha256),
                JSON.stringify({
                  v: 1,
                  saved_at: nowIso(),
                  sha256: img.sha256,
                  item: normalized,
                }),
                {
                  // optional: expire cache entries after 30 days
                  expirationTtl: 60 * 60 * 24 * 30,
                }
              )
            );
          }
          await Promise.allSettled(puts);
        }

        // Compose final batch
        analysis = buildBatchFromItems({
          mode,
          items: mergedItems,
          verdict: fresh?.verdict ?? "uncertain",
          confidence: typeof fresh?.confidence === "number" ? fresh.confidence : 0,
          ok: !!fresh?.ok, // whether model says it succeeded
          reason: fresh?.reason
            ? `${fresh.reason} (Cached: ${cachedMap.size}, Fresh: ${uncachedImages.length})`
            : `Analysis complete. (Cached: ${cachedMap.size}, Fresh: ${uncachedImages.length})`,
        });
      }
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
