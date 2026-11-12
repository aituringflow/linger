import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { loadAuthConfig } from "./auth/config.js";
import { verifySession } from "./auth/handlers.js";

function signature(payload: string): string {
  return createHmac("sha256", loadAuthConfig().sessionSecret).update(payload).digest("base64url");
}

export function issueRealtimeTicket(request: Request): Response {
  const user = verifySession(request, loadAuthConfig());
  if (!user?.sub) return Response.json({ error: "unauthorized" }, { status: 401 });
  const payload = Buffer.from(JSON.stringify({ sub: user.sub, exp: Date.now() + 30_000, nonce: randomUUID() })).toString("base64url");
  return Response.json({ ticket: `${payload}.${signature(payload)}` }, { headers: { "Cache-Control": "no-store" } });
}

export function verifyRealtimeTicket(ticket: string): string | null {
  const [payload, mac] = ticket.split(".");
  if (!payload || !mac || !/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  const expected = Buffer.from(signature(payload));
  const actual = Buffer.from(mac);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as { sub?: unknown; exp?: unknown };
    return typeof parsed.sub === "string" && parsed.sub.includes(":") && typeof parsed.exp === "number" && parsed.exp > Date.now()
      ? parsed.sub : null;
  } catch { return null; }
}
