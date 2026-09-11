// The UI/server field contract. Offline, no network, no browser.
//
// Why this exists: porting BT3's index.html produced the SAME bug twice, and
// neither would have thrown — both render silently wrong numbers on a plant floor.
//
//   1. The stockpile list read {tag, tested, source}. Danville's ?gradations=1
//      returns {agg_type, producer, status, age_days, tested_on}. Copied
//      verbatim it showed a column of blanks and badged every live stockpile
//      "none" — a tech would read that as "nothing has been sieved".
//   2. The samples panel read b.pct. db.mjs emits `percent`. Every bin would
//      have rendered "?%".
//
// A wrong number that looks like a number is worse than a crash, so the field
// names the UI reads are pinned here against the shapes the server emits.
//
//   node tests/frontend_contract.test.mjs
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log("ok:", label); }
  else { fail++; console.log("FAIL:", label); }
}

const ui    = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const agent = readFileSync(new URL("../netlify/functions/agent.mjs", import.meta.url), "utf8");
const db    = readFileSync(new URL("../netlify/functions/lib/db.mjs", import.meta.url), "utf8");
const server = agent + "\n" + db;

// --- every GET route the UI calls must exist -------------------------------
const called = [...new Set([...ui.matchAll(/ENDPOINT \+ "\?([a-z_]+)/g)].map((m) => m[1]))];
const served = new Set([...agent.matchAll(/searchParams\.has\("([a-z_]+)"\)/g)].map((m) => m[1]));
assert(called.length > 0, "the UI calls at least one GET route");
for (const r of called) assert(served.has(r), `?${r} is a route agent.mjs actually serves`);

// --- routes the Danville port deliberately removed must not come back ------
// search_contracts was dropped on Jake's call (its corpus is Boonesborough's
// jobs) and the PDF upload died with the static-data architecture. A UI that
// calls either gets a 501 or a 404 in front of a tech.
for (const gone of ["contracts=1", "contract=", "upload_gradation", "pdf_base64"])
  assert(!ui.includes(gone), `the UI does not call the removed "${gone}" path`);
assert(!/X-BT3-Site-Key/.test(ui), "the site-key header is DBT's, not BT3's (BT3's authenticates against nothing here)");

// --- the samples panel's field names must match db.mjs's sample shape ------
const panel = ui.slice(ui.indexOf("// ---------- Recent samples"), ui.indexOf("// ---------- mix-design dropdown"));
assert(panel.length > 500, "the samples panel is present and non-trivial");
for (const f of ["design_name", "sampled_at", "ac_pct", "percent", "agg_type", "still_offered", "bins"])
  assert(new RegExp(`\\b(?:sm|b)\\.${f}\\b`).test(panel) === false || new RegExp(`\\b${f}\\s*:`).test(server),
    `samples panel field "${f}" is emitted by the server`);
assert(!/\bb\.pct\b(?!_)/.test(panel), 'samples panel uses `percent`, not BT3\'s `pct`');

// --- the stockpile list's field names must match ?gradations=1 -------------
// Slice forward from the declaration to the next one. gradBadge happens to be
// defined ABOVE loadGradList, so slicing between the two names ran backwards and
// silently graded an empty string — a test that passes on nothing is the same
// failure mode this file exists to catch.
const gradStart = ui.indexOf("function loadGradList");
const gradFn = gradStart < 0 ? "" : ui.slice(gradStart, ui.indexOf("\n  function ", gradStart + 10));
assert(gradFn.includes("agg_type") && gradFn.includes("tested_on"),
  "stockpile list reads Danville's {agg_type, tested_on}");
assert(!/g\.tag\b/.test(gradFn) && !/g\.tested\b(?!_)/.test(gradFn),
  "stockpile list does NOT read BT3's {tag, tested}");

// --- non-negotiable 5: every SSE event the server emits has a renderer -----
const emitted = new Set([...server.matchAll(/type:\s*"(start|round|text|tool|tool_result|notice|error|done)"/g)].map((m) => m[1]));
const sw = ui.slice(ui.indexOf("function handleEvent"), ui.indexOf("function finishTurn"));
const handled = new Set([...sw.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]));
assert(emitted.size >= 8, `server emits at least 8 SSE types (found ${emitted.size})`);
for (const e of emitted) assert(handled.has(e), `SSE "${e}" has a browser renderer`);

// --- the PWA cache name must not collide with BT3's ------------------------
// Same Netlify team, same shell filenames. A shared cache key is how a tech's
// installed Danville app serves Boonesborough's UI out of cache.
const sw_js = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const cacheName = (sw_js.match(/const CACHE = "([^"]+)"/) || [])[1];
assert(!!cacheName, "sw.js declares a cache name");
assert(cacheName && !cacheName.includes("bt3"), `sw.js cache name is Danville's, not BT3's (got "${cacheName}")`);

// --- every element id the JS reaches for must exist in the markup ----------
const ids  = new Set([...ui.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
const used = new Set([...ui.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]));
const dangling = [...used].filter((u) => !ids.has(u));
assert(dangling.length === 0, `no $("id") points at a deleted element (dangling: ${dangling.join(", ") || "none"})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
