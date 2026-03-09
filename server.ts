/**
 * tokscale-hub — local aggregation proxy for tokscale.ai
 *
 * Each device sets TOKSCALE_API_URL=http://<hub-host>:7171 and runs
 * `tokscale submit` as usual.  The hub merges all device submissions and
 * pushes the combined result to the real tokscale.ai on demand.
 *
 * Environment variables:
 *   HUB_PORT            Listening port (default: 7171)
 *   HUB_TOKEN           Comma-separated Bearer tokens for pushing to tokscale.ai.
 *                       Each token submits independently so you can fan-out to
 *                       multiple accounts. Get tokens from each device's
 *                       ~/.config/tokscale/credentials.json after logging in.
 *   HUB_UPSTREAM        Upstream URL (default: https://tokscale.ai)
 *   HUB_STORE_PATH      Path to the JSON store file (default: ./hub-store.json)
 *   HUB_SECRET          Optional shared secret — devices must send
 *                       Authorization: Bearer <HUB_SECRET> when submitting.
 *                       If unset, any submission is accepted (fine for LAN use).
 *   HUB_AUTO_PUSH       If "1", push to upstream immediately after every
 *                       device submission (default: 0 — manual push only).
 */

import type { TokenContributionData } from "./types.ts";
import { loadStore, saveStore, upsertSubmission, listSubmissions } from "./store.ts";
import { mergeContributions } from "./merge.ts";

const PORT = Number(process.env.HUB_PORT ?? 7171);
const UPSTREAM = (process.env.HUB_UPSTREAM ?? "https://tokscale.ai").replace(/\/$/, "");
const HUB_TOKENS: string[] = (process.env.HUB_TOKEN ?? "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const HUB_SECRETS: string[] = (process.env.HUB_SECRET ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const AUTO_PUSH = process.env.HUB_AUTO_PUSH === "1";

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/**
 * Extract device identifier from a request.
 * We derive it from the device's own Bearer token so submissions from
 * the same device always overwrite each other (idempotent).
 */
function deviceIdFromRequest(req: Request): string {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return "anonymous";
  // Use just the last 12 chars to avoid logging full tokens
  return `device-${token.slice(-12)}`;
}

/**
 * Verify the request against HUB_SECRET (if configured).
 * When HUB_SECRET is not set we trust all incoming submissions — suitable
 * for local-only / trusted LAN use.
 */
function authorized(req: Request): boolean {
  if (HUB_SECRETS.length === 0) return true;
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  return HUB_SECRETS.includes(token);
}

// ---------------------------------------------------------------------------
// Push merged data to tokscale.ai
// ---------------------------------------------------------------------------

interface PushResult {
  ok: boolean;
  status: number;
  body: unknown;
}

async function pushWithToken(merged: TokenContributionData, token: string): Promise<PushResult> {
  const resp = await fetch(`${UPSTREAM}/api/submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(merged),
  });

  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    body = { error: `Non-JSON response (HTTP ${resp.status})` };
  }

  return { ok: resp.ok, status: resp.status, body };
}

async function pushToUpstream(
  merged: TokenContributionData
): Promise<{ results: PushResult[]; allOk: boolean }> {
  if (HUB_TOKENS.length === 0) {
    const err = { ok: false, status: 0, body: { error: "HUB_TOKEN not configured" } };
    return { results: [err], allOk: false };
  }

  const results = await Promise.all(HUB_TOKENS.map((t) => pushWithToken(merged, t)));
  return { results, allOk: results.every((r) => r.ok) };
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method.toUpperCase();

  // ── Health check ──────────────────────────────────────────────────────────
  if (method === "GET" && path === "/health") {
    return json({ status: "ok", upstream: UPSTREAM });
  }

  // ── Status: show what devices have submitted and last push time ───────────
  if (method === "GET" && path === "/api/hub/status") {
    const store = loadStore();
    const subs = listSubmissions(store);
    return json({
      devices: subs.map((s) => ({
        deviceId: s.deviceId,
        receivedAt: s.receivedAt,
        totalTokens: s.data.summary.totalTokens,
        totalCost: s.data.summary.totalCost,
        activeDays: s.data.summary.activeDays,
        clients: s.data.summary.clients,
        dateRange: s.data.meta.dateRange,
      })),
      lastPushedAt: store.lastPushedAt,
      deviceCount: subs.length,
    });
  }

  // ── Preview: return merged payload without pushing ─────────────────────
  if (method === "GET" && path === "/api/hub/preview") {
    const store = loadStore();
    const subs = listSubmissions(store);
    if (subs.length === 0) {
      return json({ error: "No submissions yet" }, 404);
    }
    const merged = mergeContributions(subs.map((s) => s.data));
    return json({ merged });
  }

  // ── Manual push: merge all and push to tokscale.ai ─────────────────────
  if (method === "POST" && path === "/api/hub/push") {
    const store = loadStore();
    const subs = listSubmissions(store);
    if (subs.length === 0) {
      return json({ error: "No submissions to push" }, 400);
    }

    const merged = mergeContributions(subs.map((s) => s.data));
    const { results, allOk } = await pushToUpstream(merged);

    if (allOk) {
      store.lastPushedAt = new Date().toISOString();
      saveStore(store);
    }

    return json(
      {
        pushed: allOk,
        tokenCount: HUB_TOKENS.length,
        upstreamResults: results.map((r, i) => ({
          tokenIndex: i,
          status: r.status,
          ok: r.ok,
          response: r.body,
        })),
        mergedSummary: merged.summary,
        deviceCount: subs.length,
      },
      allOk ? 200 : 502
    );
  }

  // ── Delete a specific device's submission ─────────────────────────────────
  if (method === "DELETE" && path.startsWith("/api/hub/device/")) {
    const deviceId = decodeURIComponent(path.slice("/api/hub/device/".length));
    const store = loadStore();
    if (!store.submissions[deviceId]) {
      return json({ error: "Device not found" }, 404);
    }
    delete store.submissions[deviceId];
    saveStore(store);
    return json({ deleted: deviceId });
  }

  // ── Receive submission from a device (tokscale CLI calls POST /api/submit) ─
  if (method === "POST" && path === "/api/submit") {
    if (!authorized(req)) {
      return json({ error: "Unauthorized" }, 401);
    }

    let payload: TokenContributionData;
    try {
      payload = (await req.json()) as TokenContributionData;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (!payload?.contributions || !payload?.summary) {
      return json({ error: "Invalid payload shape" }, 400);
    }

    const deviceId = deviceIdFromRequest(req);
    const store = loadStore();
    upsertSubmission(store, deviceId, payload);
    saveStore(store);

    console.log(
      `[hub] Stored submission from ${deviceId} — ` +
        `${payload.summary.totalTokens.toLocaleString()} tokens, ` +
        `${payload.summary.activeDays} active days`
    );

    if (AUTO_PUSH && listSubmissions(store).length > 0) {
      const subs = listSubmissions(store);
      const merged = mergeContributions(subs.map((s) => s.data));
      const { results, allOk } = await pushToUpstream(merged);
      if (allOk) {
        store.lastPushedAt = new Date().toISOString();
        saveStore(store);
        console.log(`[hub] Auto-pushed merged data to ${HUB_TOKENS.length} token(s)`);
      } else {
        console.error("[hub] Auto-push failed:", results.filter((r) => !r.ok));
      }
    }

    // Return a success response that matches what tokscale.ai returns
    // so the CLI shows a nice success message.
    return json({
      submissionId: `hub-${deviceId}-${Date.now()}`,
      username: "hub",
      metrics: {
        totalTokens: payload.summary.totalTokens,
        totalCost: payload.summary.totalCost,
        activeDays: payload.summary.activeDays,
      },
      warnings: AUTO_PUSH
        ? []
        : ["Data stored in hub. Run POST /api/hub/push to forward to tokscale.ai."],
    });
  }

  // ── Proxy auth endpoints to upstream (so devices can log in via the hub) ──
  if (
    method === "POST" &&
    (path === "/api/auth/device" || path === "/api/auth/device/poll")
  ) {
    const body = await req.text();
    const upstreamResp = await fetch(`${UPSTREAM}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const upstreamBody = await upstreamResp.text();
    return new Response(upstreamBody, {
      status: upstreamResp.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  return json({ error: `Not found: ${method} ${path}` }, 404);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

console.log(`
┌─────────────────────────────────────────────────────┐
│  tokscale-hub                                       │
│                                                     │
│  Listening on  http://0.0.0.0:${String(PORT).padEnd(25)}│
│  Upstream      ${UPSTREAM.padEnd(37)}│
│  Auto-push     ${(AUTO_PUSH ? "yes" : "no — use POST /api/hub/push").padEnd(37)}│
│  Tokens        ${String(HUB_TOKENS.length + " configured").padEnd(37)}│
│  Auth          ${(HUB_SECRETS.length ? `${HUB_SECRETS.length} secret(s) required` : "open (no secret set)").padEnd(37)}│
└─────────────────────────────────────────────────────┘

On each device, set:
  TOKSCALE_API_URL=http://<hub-ip>:${PORT}
Then run:
  tokscale submit

To push merged data to tokscale.ai:
  curl -X POST http://localhost:${PORT}/api/hub/push
`);

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  fetch: async (req) => {
    try {
      return await handleRequest(req);
    } catch (err) {
      console.error("[hub] Unhandled error:", err);
      return json({ error: "Internal server error", detail: String(err) }, 500);
    }
  },
  error(err) {
    console.error("[hub] Server error:", err);
    return json({ error: "Internal server error", detail: String(err) }, 500);
  },
});
