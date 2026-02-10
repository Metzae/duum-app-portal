export async function postToDuumProposal(proposal, env) {
  const base = (env.DUUM_WP_BASE || "").replace(/\/+$/, "");
  const token = env.DUUM_WP_TOKEN || "";
  if (!base || !token) throw new Error("Missing DUUM_WP_BASE or DUUM_WP_TOKEN");

  const r = await fetch(`${base}/wp-json/duum/v1/proposals`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Duum-Token": token,
    },
    body: JSON.stringify(proposal),
  });

  const raw = await r.text();
  let j;
  try { j = JSON.parse(raw); } catch { j = { raw }; }

  if (!r.ok) {
    throw new Error(`Duum proposal POST failed (${r.status}): ${raw.slice(0, 500)}`);
  }

  return j;
}
