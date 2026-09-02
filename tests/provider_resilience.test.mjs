// Provider routing + loop resilience.
//
// Three things a tech on the plant floor actually feels:
//   1. picking "Grok 4.5" has to hit the 4.5 model with the right key
//   2. a transient 429 must not cost them the question (two retries, backing off)
//   3. a hard provider failure AFTER we retrieved data must still produce an answer
//      instead of a red box and a retype ("retry the node, not the run")
//
//   node tests/provider_resilience.test.mjs
//
// Note: case 2 sleeps through the real backoff (2.5s + 6s), so this suite takes ~10s.

import http from "http";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok: " + m); } else { fail++; console.log("FAIL: " + m); } };

// ---- stub xAI ---------------------------------------------------------------
let script = [];            // queue of responses for successive calls
let stubMode = null;        // "grind" = keep demanding tools until tool_choice:none
const seen = [];            // {model, auth} per call
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body);
    seen.push({ model: parsed.model, auth: req.headers.authorization || "" });
    if (stubMode === "hang") return;   // never respond — simulates a stalled provider
    const grinding = stubMode === "grind" && parsed.tool_choice !== "none";
    const next = grinding ? { kind: "tool" } : (script.shift() || { kind: "answer", text: "Bottom line: Do now — forced answer." });
    if (next.kind === "status") { res.writeHead(next.status, { "content-type": "application/json" }); return res.end('{"error":"stub"}'); }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (next.kind === "tool") {
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","type":"function","function":{"name":"get_aggregates","arguments":"{}"}}]},"finish_reason":null}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
    } else {
      res.write('data: {"choices":[{"delta":{"content":' + JSON.stringify(next.text) + '},"finish_reason":null}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

process.env.XAI_API_KEY = "key-43";
process.env.XAI_MODEL = "grok-4-3-stub";
process.env.RATE_LIMIT_PER_MIN = "0";
process.env.RATE_LIMIT_PER_DAY = "0";
const mod = await import("../netlify/functions/agent.mjs");

const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) =>
  String(url).includes("api.x.ai") ? realFetch("http://127.0.0.1:" + port, opts) : realFetch(url, opts);

async function ask(provider, prompt = "voids low on the 0.38A, what do I change?") {
  seen.length = 0;
  const res = await mod.default(new Request("http://x/", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, messages: [{ role: "user", content: prompt }] }),
  }));
  return res.text();
}

// ---- 1. model + key routing -------------------------------------------------
script = [{ kind: "answer", text: "Bottom line: 4.3 answered." }];
await ask("grok");
ok(seen[0].model === "grok-4-3-stub", "provider 'grok' uses XAI_MODEL");
ok(seen[0].auth.includes("key-43"), "provider 'grok' uses XAI_API_KEY");

process.env.XAI_MODEL_45 = "grok-4-5-stub";
script = [{ kind: "answer", text: "Bottom line: 4.5 answered." }];
await ask("grok45");
ok(seen[0].model === "grok-4-5-stub", "provider 'grok45' uses XAI_MODEL_45");
ok(seen[0].auth.includes("key-43"), "grok45 falls back to XAI_API_KEY when no 4.5-specific key is set");

process.env.XAI_API_KEY_45 = "key-45";
script = [{ kind: "answer", text: "Bottom line: 4.5 answered." }];
await ask("grok45");
ok(seen[0].auth.includes("key-45"), "grok45 prefers XAI_API_KEY_45 when it IS set");

script = [{ kind: "answer", text: "Bottom line: 4.3 answered." }];
await ask("grok");
ok(seen[0].auth.includes("key-43"), "the 4.5 key never leaks into the 4.3 slot");

// an unknown provider must not silently become Grok
script = [{ kind: "answer", text: "x" }];
const bogus = await ask("grok99");
ok(!/4\.5 answered/.test(bogus) && seen.length === 0, "unknown provider falls through to Claude, not Grok");

// ---- 2. transient 429 costs the tech nothing --------------------------------
console.log("  (sleeping through the real 2.5s + 6s backoff…)");
script = [{ kind: "status", status: 429 }, { kind: "status", status: 429 }, { kind: "answer", text: "Bottom line: survived the 429s." }];
const t0 = Date.now();
const retried = await ask("grok");
const elapsed = Date.now() - t0;
ok(seen.length === 3, "a 429 is retried twice before giving up (3 attempts total), got " + seen.length);
ok(/survived the 429s/.test(retried), "the tech still gets their answer after two 429s");
ok(elapsed >= 8000, "the retries actually back off rather than hammering (" + elapsed + "ms)");

// ---- 3. hard failure after real tool work still answers ---------------------
// round 1 returns a tool call; round 2 dies with a NON-retryable 400.
script = [{ kind: "tool" }, { kind: "status", status: 400 }, { kind: "answer", text: "Bottom line: partial answer from what we had." }];
const salvaged = await ask("grok");
ok(/partial answer from what we had/.test(salvaged), "mid-loop hard failure still produces an answer");
ok(/cut short/i.test(salvaged), "the tech is told the run was cut short, not given a silent partial");
ok(!/finished without producing an answer/.test(salvaged), "no 'no answer' error when we had data in hand");

// ---- 4. but a failure with NOTHING retrieved shows the real error -----------
// Nothing was retrieved, so there is nothing to answer from — papering over that
// would hand the tech a confident answer built on no data.
script = [{ kind: "status", status: 400 }];
const bare = await ask("grok");
ok(/error/i.test(bare) && !/Bottom line/.test(bare), "a failure before any tool work surfaces the real error");

// ---- 5. wall-clock deadline forces the answer while there is still road -----
// The failure this guards: a model that iterates (try a split, check it, reject it,
// try another) burns every round on tool calls and the run gets cut off mid-narration
// with no answer at all. Rounds are the wrong unit; seconds are the real constraint.
stubMode = "grind";   // a model that never volunteers an answer — the 4.5 failure shape
{
  // Baseline: no budget, so only MAX_ROUNDS stops it.
  process.env.AGENT_TIME_BUDGET_MS = "0";
  const ground = await ask("grok");
  const roundsBurned = seen.length;
  ok(/Do now/.test(ground), "without a budget the round limit still eventually answers");
  ok(roundsBurned >= 10, "…but only after grinding through the rounds (" + roundsBurned + " calls)");

  // Same stub, tiny budget: the deadline should cut it short and land the answer.
  process.env.AGENT_TIME_BUDGET_MS = "1";
  process.env.AGENT_ANSWER_RESERVE_MS = "1";
  const timed = await ask("grok");
  ok(/Do now/.test(timed), "deadline still produces a real answer");
  ok(seen.length < roundsBurned / 2, "deadline cuts the grind short: " + seen.length + " calls vs " + roundsBurned);
}
stubMode = null;

// a generous budget must NOT force early — the guard is a backstop, not a leash
{
  process.env.AGENT_TIME_BUDGET_MS = "60000";
  process.env.AGENT_ANSWER_RESERVE_MS = "15000";
  script = [{ kind: "tool" }, { kind: "answer", text: "Bottom line: Do now — normal run." }];
  const normal = await ask("grok");
  ok(/normal run/.test(normal), "a generous budget lets the loop run its tool round first");
  ok(seen.length === 2, "no premature forcing: one tool round then the answer (" + seen.length + ")");
}

// disabling the budget restores pure round-based behaviour
{
  process.env.AGENT_TIME_BUDGET_MS = "0";
  script = [{ kind: "tool" }, { kind: "answer", text: "Bottom line: Do now — budget off." }];
  const off = await ask("grok");
  ok(/budget off/.test(off), "AGENT_TIME_BUDGET_MS=0 disables the deadline entirely");
}

// ---- 6. a stalled provider is aborted, not left to hit the platform kill ----
// Model calls previously had NO timeout (only the Dataverse stub did), so a slow
// forced answer ran until Netlify killed the invocation at 60s — which is exactly
// the "network error" a tech sees. The call must now be bounded by time remaining.
{
  process.env.AGENT_TIME_BUDGET_MS = "6000";    // -> callTimeout floors at 5000ms
  process.env.AGENT_ANSWER_RESERVE_MS = "6000";
  stubMode = "hang";
  const t = Date.now();
  const hung = await ask("grok");
  const took = Date.now() - t;
  stubMode = null;
  ok(took < 30000, "a stalled provider is aborted rather than hanging (" + took + "ms)");
  ok(/error|cut short/i.test(hung), "the tech is told something went wrong instead of getting silence");
}

server.close();
console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
