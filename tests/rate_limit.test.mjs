// Rate-limit smoke test — the chat endpoint is unauthenticated, so this is the
// only thing standing between a stranger with the URL and our model budget.
//
// The two behaviours that matter most are the ones that are easy to get wrong:
//   * techs behind ONE plant IP must not get locked out for the day
//   * if Blobs is down the plant keeps working (fail open)
//
//   node tests/rate_limit.test.mjs

import { checkRateLimit, clientIp } from "../netlify/functions/agent.mjs";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("ok: " + msg); } else { fail++; console.log("FAIL: " + msg); } };

// In-memory stand-in for the Blobs store (same get/setJSON surface we use).
function fakeStore() {
  const m = new Map();
  return {
    map: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async setJSON(k, v) { m.set(k, v); },
  };
}
const reqFrom = (ip) => ({ headers: { get: (h) => (h === "x-nf-client-connection-ip" ? ip : null) } });

async function hit(store, ip) { return checkRateLimit(reqFrom(ip), store); }

// --- IP extraction -----------------------------------------------------------
ok(clientIp(reqFrom("10.1.2.3")) === "10.1.2.3", "reads Netlify client IP header");
ok(
  clientIp({ headers: { get: (h) => (h === "x-forwarded-for" ? "203.0.113.9, 70.0.0.1" : null) } }) === "203.0.113.9",
  "falls back to first x-forwarded-for entry"
);
ok(clientIp({ headers: { get: () => null } }) === "unknown", "no IP headers → 'unknown', still counted");

// --- per-IP burst ------------------------------------------------------------
process.env.RATE_LIMIT_PER_MIN = "3";
process.env.RATE_LIMIT_PER_DAY = "1000";
{
  const store = fakeStore();
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await hit(store, "1.1.1.1"));
  ok(results.slice(0, 3).every((r) => r.ok), "first 3 requests pass");
  ok(results[3].ok === false && results[3].status === 429, "4th request is blocked with 429");
  ok(/minute/i.test(results[4].error), "block message tells the tech to wait a minute");
  ok(results[4].retryAfter === 60, "retry-after is 60s on a burst block");

  // a second tech from a DIFFERENT IP must not inherit the first one's block
  ok((await hit(store, "2.2.2.2")).ok, "different IP has its own bucket");

  // only one key per IP — no unbounded key growth per minute
  ok([...store.map.keys()].filter((k) => k.startsWith("ip/")).length === 2, "one self-overwriting key per IP");
}

// --- window rollover ---------------------------------------------------------
{
  const store = fakeStore();
  for (let i = 0; i < 3; i++) await hit(store, "3.3.3.3");
  ok((await hit(store, "3.3.3.3")).ok === false, "blocked at the cap");
  store.map.set("ip/3.3.3.3", { w: 0, n: 99 }); // pretend that count was an old minute
  ok((await hit(store, "3.3.3.3")).ok, "a new minute resets the count");
}

// --- the plant-lockout guard -------------------------------------------------
// Several techs NAT'd behind one office IP is the normal case, not the attack.
{
  process.env.RATE_LIMIT_PER_MIN = "20";
  const store = fakeStore();
  let allOk = true;
  for (let i = 0; i < 20; i++) if (!(await hit(store, "plant-nat")).ok) allOk = false;
  ok(allOk, "20 requests/min from one shared plant IP all pass");
  // and crucially there is no per-IP DAILY key that would lock them out later
  ok(![...store.map.keys()].some((k) => /^ip\/.*\d{4}-\d{2}-\d{2}/.test(k)), "no per-IP daily cap exists to lock out the plant");
}

// --- global daily ceiling ----------------------------------------------------
{
  process.env.RATE_LIMIT_PER_MIN = "1000";
  process.env.RATE_LIMIT_PER_DAY = "4";
  const store = fakeStore();
  for (let i = 0; i < 4; i++) await hit(store, `ip-${i}`); // 4 different IPs
  const blocked = await hit(store, "ip-fresh");
  ok(blocked.ok === false, "global cap blocks even a brand-new IP");
  ok(/daily/i.test(blocked.error) && blocked.retryAfter === 3600, "daily block says daily, retries in an hour");
}

// --- fail open ---------------------------------------------------------------
{
  process.env.RATE_LIMIT_PER_MIN = "1";
  process.env.RATE_LIMIT_PER_DAY = "1";
  const broken = { async get() { throw new Error("blobs down"); }, async setJSON() { throw new Error("blobs down"); } };
  const r = await checkRateLimit(reqFrom("9.9.9.9"), broken);
  ok(r.ok, "Blobs failure fails OPEN — techs keep working");
}

// --- kill switch -------------------------------------------------------------
{
  process.env.RATE_LIMIT_PER_MIN = "0";
  process.env.RATE_LIMIT_PER_DAY = "0";
  const store = fakeStore();
  let allOk = true;
  for (let i = 0; i < 50; i++) if (!(await hit(store, "8.8.8.8")).ok) allOk = false;
  ok(allOk, "both limits at 0 disables limiting entirely");
  ok(store.map.size === 0, "disabled limiter does no Blobs work at all");
}

console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
