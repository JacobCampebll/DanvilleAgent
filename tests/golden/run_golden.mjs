// Golden-case runner — grades the LIVE Danville agent against
// netlify/functions/lib/golden_cases.mjs.
//
//   DBT_SITE_KEY=… node tests/golden/run_golden.mjs            # live site, grok
//   node tests/golden/run_golden.mjs --key=…                   # same, key inline
//   node tests/golden/run_golden.mjs --provider=claude         # needs ANTHROPIC_API_KEY on the site
//   node tests/golden/run_golden.mjs --base=http://localhost:8888   # netlify dev
//   node tests/golden/run_golden.mjs --suite=mix               # mix-change cases only
//   node tests/golden/run_golden.mjs --only=fingerprint-038d-fine-surface-pair
//
// Each case is sent as a fresh single-message conversation; the SSE stream is
// collected into the final answer text and graded with the case's regexes.
// mustMatch/mustNotMatch are hard pass/fail; softMatch only warns (⚠) so
// wording drift doesn't fail the suite. Exit code 1 on any hard failure.
//
// NOTE: runs against the DEPLOYED function — the model keys live there, not
// here, so this cannot be run from a checkout alone. Grok answers vary run to
// run; a hard failure is a real doctrine break, but run twice before panicking.
//
// Three things that differ from BT3's runner, each for a reason:
//
//  1. SITE KEY. Danville's function is gated on SITE_PASSWORD and answers 401
//     {"error":"site_auth_required"} without it, so BT3's runner reaches nothing
//     here. Pass it as DBT_SITE_KEY in the environment (preferred — an inline
//     --key= lands in shell history) or as --key=. Sent as X-DBT-Site-Key.
//
//  2. RATE LIMITING is reported separately from grading. The function allows 20
//     requests/minute/IP by default; a full 24-case run that answers quickly can
//     trip it. A 429 is a budget guard doing its job, NOT a doctrine break, so
//     it is retried once honouring Retry-After and, if it persists, reported as
//     RATE-LIMITED — never as FAIL, which is what would send the next reader
//     hunting a regression that isn't there.
//
//  3. DEFAULT PROVIDER is grok because that is the only model key the Danville
//     site is configured with (XAI_API_KEY). --provider=claude will 5xx until
//     ANTHROPIC_API_KEY is added there; check with ?envcheck first.

import cases from "../../netlify/functions/lib/golden_cases.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const BASE = (args.base || process.env.DBT_BASE || "https://danville.netlify.app").replace(/\/$/, "");
const ENDPOINT = BASE + "/.netlify/functions/agent";
const PROVIDER = args.provider || "grok";
const SITE_KEY = String(args.key === true ? "" : (args.key || process.env.DBT_SITE_KEY || ""));
const only = args.only ? String(args.only).split(",") : null;
const SUITE = (args.suite || "all").toLowerCase();
const PACE_MS = Number(args.pace || process.env.DBT_GOLDEN_PACE_MS || 3500);

class RateLimited extends Error {
  constructor(retryAfter) { super("rate limited"); this.retryAfter = retryAfter; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postOnce(prompt) {
  const headers = { "content-type": "application/json" };
  if (SITE_KEY) headers["X-DBT-Site-Key"] = SITE_KEY;
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ provider: PROVIDER, messages: [{ role: "user", content: prompt }] }),
  });

  if (res.status === 401) {
    // Distinguish "no key given" from "wrong key" — both 401, very different fixes.
    throw new Error(
      SITE_KEY
        ? "401 site_auth_required — the site key was sent but rejected. Check SITE_PASSWORD in Netlify."
        : "401 site_auth_required — no site key sent. Set DBT_SITE_KEY or pass --key=<SITE_PASSWORD>."
    );
  }
  if (res.status === 429) {
    throw new RateLimited(Number(res.headers.get("retry-after")) || 60);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", answer = "", err = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      if (ev.type === "text" && ev.text) answer += ev.text;
      if (ev.type === "answer" && ev.text) answer = ev.text;
      if (ev.type === "error") err = ev.message || "agent error";
    }
  }
  if (err && !answer) throw new Error(err);
  return answer;
}

// One retry on 429 only. Everything else surfaces immediately — a retry loop
// over real failures just multiplies the model spend for the same red result.
async function askAgent(prompt) {
  try {
    return await postOnce(prompt);
  } catch (e) {
    if (!(e instanceof RateLimited)) throw e;
    const wait = Math.min(e.retryAfter, 120);
    process.stdout.write(`rate-limited, waiting ${wait}s … `);
    await sleep(wait * 1000);
    return await postOnce(prompt);
  }
}

function grade(c, answer) {
  const failures = [], warnings = [];
  for (const p of c.mustMatch || []) {
    if (!new RegExp(p, "i").test(answer)) failures.push(`missing required: /${p}/`);
  }
  for (const p of c.mustNotMatch || []) {
    if (p && new RegExp(p, "i").test(answer)) failures.push(`forbidden matched: /${p}/`);
  }
  for (const p of c.softMatch || []) {
    if (!new RegExp(p, "i").test(answer)) warnings.push(`soft miss: /${p}/`);
  }
  return { failures, warnings };
}

let toRun = SUITE === "all" ? cases : cases.filter((c) => (c.suite || "core") === SUITE);
if (only) toRun = toRun.filter((c) => only.includes(c.id));

if (!toRun.length) {
  console.error(`No cases matched (suite=${SUITE}${only ? `, only=${only.join(",")}` : ""}).`);
  process.exit(2);
}
if (!SITE_KEY && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE)) {
  console.log("⚠ no site key set — expect 401 unless SITE_PASSWORD is unset on the target.\n");
}

console.log(`Golden run → ${ENDPOINT} (provider=${PROVIDER}, suite=${SUITE}) — ${toRun.length} case(s)\n`);

let failed = 0, limited = 0, first = true;
for (const c of toRun) {
  if (!first && PACE_MS > 0) await sleep(PACE_MS);
  first = false;
  process.stdout.write(`▶ ${c.id} … `);
  let answer;
  try {
    answer = await askAgent(c.prompt);
  } catch (e) {
    if (e instanceof RateLimited) {
      limited++;
      console.log("RATE-LIMITED (not graded — raise RATE_LIMIT_PER_MIN or --pace)");
      continue;
    }
    console.log(`ERROR (${e.message})`);
    failed++;
    continue;
  }
  const { failures, warnings } = grade(c, answer);
  if (failures.length) {
    failed++;
    console.log("FAIL");
    failures.forEach((f) => console.log("    ✗ " + f));
    console.log("    — why this case exists: " + c.why);
    console.log("    — answer head: " + answer.slice(0, 260).replace(/\n/g, " ") + "…");
  } else {
    console.log("pass" + (warnings.length ? `  (⚠ ${warnings.join("; ")})` : ""));
  }
}

const graded = toRun.length - limited;
console.log(
  `\n${graded - failed}/${graded} graded passed` +
  (failed ? ` — ${failed} FAILED` : "") +
  (limited ? ` — ${limited} not graded (rate limited)` : "")
);
// Ungraded cases are not a pass. Exit non-zero so CI or a shell loop cannot
// read a rate-limited run as a green suite.
process.exit(failed || limited ? 1 : 0);
