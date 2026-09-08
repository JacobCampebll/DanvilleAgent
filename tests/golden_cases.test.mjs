// Structural tests for the golden cases. Offline — this grades the CASES, not
// the agent. Grading the agent needs the deployed function and real model keys
// (tests/golden/run_golden.mjs); this suite is what `npm test` can actually run,
// and it exists because a badly written assertion is worse than a missing one:
// it reports green while checking nothing.
//
// The two rules below are BT3's grading lessons, both paid for by a false
// result, turned into checks so they cannot be re-learned:
//
//   1. KEEP THE UNIT. A bare /10/ false-PASSES on "the washed 10s", "#10",
//      "100%", "2010". This caught three of my own assertions on the first run
//      — one of them ("10" on the 1.00D Base, which carries #10 at 21%) would
//      have passed on essentially any answer.
//   2. ASSERTIONS ARE POSITIVE. A mustNotMatch of a bare direction phrase
//      ("increase AC") false-FIRES on the correct answer "do NOT increase AC",
//      so a forbidden pattern has to carry enough context to distinguish them.
//
//   node tests/golden_cases.test.mjs
import cases from "../netlify/functions/lib/golden_cases.mjs";

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log("ok:", label); }
  else { fail++; console.log("FAIL:", label); }
}

// Danville's 21 active designs, snapshotted from the live db 2026-09-02. This is
// a deliberate offline copy, not a second source of truth to maintain: its only
// job is to fail loudly if a future case is authored against a design name that
// does not exist. Re-verify it (and this comment's date) when designs change.
const ACTIVE_DESIGNS = new Set([
  "CL3 0.38A 64-22 Surface",
  "CL3 0.38B 64-22 Gaddie Surface",
  "CL3 0.38B 64-22 Surface",
  "CL3 0.38D 64-22 Coarse Surface",
  "CL3 0.38D 64-22 Fine Surface",
  "CL3 0.38D 64-22 Fine Surface (3038D64F01)",
  "CL3 0.38D 64-22 NS Coarse Surface",
  "CL3 0.38D 64-22 NS State Surface",
  "CL3 0.38D 64-22 State Surface",
  "CL3 0.38D 64-22 State Surface (3038D64C01)",
  "CL3 0.38D 76-22 Surface",
  "CL3 0.50A 64-22 Binder",
  "CL3 0.50D 64-22 Binder",
  "CL3 0.50D 64-22 Binder (3050D64S00)",
  "CL3 0.75D 64-22 Base",
  "CL3 0.75D 64-22 Base (3075D64B00)",
  "CL3 1.00D 64-22 Base",
  "CL3 1.00D 76-22 Base",
  "CL3 No.4D 64-22 Surface",
  "CL3 NO.4A 64-22 Surface",
  "CL3 NO.4B 64-22 Surface",
]);

// Cases that deliberately name no design. Each needs a reason, because
// "forgot to name one" and "the absence IS the test" look identical otherwise.
const DESIGNLESS_OK = new Map([
  ["never-refuse-no-design-match",
   "the whole point is that the tech does not know which design sheet it is"],
]);

// --- shape -------------------------------------------------------------------
assert(Array.isArray(cases) && cases.length > 0, "default export is a non-empty array");
assert(cases.length === 24, `24 cases (22 BT3 behaviours + 2 Danville-only) — got ${cases.length}`);

const ids = cases.map((c) => c.id);
assert(new Set(ids).size === ids.length, "case ids are unique");

const bySuite = {};
for (const c of cases) bySuite[c.suite] = (bySuite[c.suite] || 0) + 1;
assert(bySuite.core === 13 && bySuite.mix === 11,
  `suites split 13 core / 11 mix — got ${JSON.stringify(bySuite)}`);
assert(Object.keys(bySuite).every((s) => s === "core" || s === "mix"),
  'every suite is "core" or "mix" (the runner filters on it)');

for (const c of cases) {
  const at = `[${c.id || "<no id>"}]`;
  assert(typeof c.id === "string" && /^[a-z0-9-]+$/.test(c.id),
    `${at} id is a kebab-case slug (it is a --only= argument)`);
  assert(typeof c.prompt === "string" && c.prompt.length > 40,
    `${at} prompt reads like something a tech would actually send`);
  // A case whose reason is not written down gets deleted by the next reader who
  // cannot tell what it locks. BT3's shortest `why` is one full sentence.
  assert(typeof c.why === "string" && c.why.length >= 60,
    `${at} why: states the behaviour being locked`);
  assert(Array.isArray(c.mustMatch) && c.mustMatch.length > 0,
    `${at} has at least one mustMatch — a case with none cannot fail`);
}

// --- every pattern compiles --------------------------------------------------
// A bad regex throws inside the runner's grade(), which reports it as an ERROR
// on that one case and keeps going, so it can hide in a red run indefinitely.
for (const c of cases) {
  for (const [field, pats] of [["mustMatch", c.mustMatch], ["mustNotMatch", c.mustNotMatch], ["softMatch", c.softMatch]]) {
    for (const p of pats || []) {
      let ok = true;
      try { new RegExp(p, "i"); } catch { ok = false; }
      assert(ok, `[${c.id}] ${field} /${p}/ compiles`);
    }
  }
}

// --- lesson 1: keep the unit --------------------------------------------------
// Flag any hard assertion made only of digits, whitespace and alternation bars.
// "15" is flagged; "15\s*%", "#9", "0\.38D" and "\b\d{8}\b" are not.
const BARE_NUMBER = /^[\d\s|]+$/;
for (const c of cases) {
  for (const [field, pats] of [["mustMatch", c.mustMatch], ["mustNotMatch", c.mustNotMatch]]) {
    for (const p of pats || []) {
      assert(!BARE_NUMBER.test(p),
        `[${c.id}] ${field} /${p}/ carries a unit or context, not a bare number`);
    }
  }
}

// --- lesson 2: forbidden patterns carry context ------------------------------
// A mustNotMatch has to be specific enough not to fire on the correct answer.
// The mechanical proxy: it must be more than a short bare phrase — either long
// enough to be unambiguous, or structured (alternation, quantifier, anchor).
const STRUCTURED = /[|{}()\[\]\\+*?]/;
for (const c of cases) {
  for (const p of c.mustNotMatch || []) {
    assert(p.length >= 18 || STRUCTURED.test(p),
      `[${c.id}] mustNotMatch /${p}/ is specific enough not to fire on a correct answer`);
  }
}

// --- prompts are grounded in real Danville designs ---------------------------
// A case authored against a design that does not exist tests the fallback path
// by accident and reports it as the behaviour under test.
// Matched by SUBSTRING rather than by parsing the name out of the prose. The
// first attempt did the latter and every case failed on "CL3 0": design names
// carry periods ("0.38A", "No.4D") and so do the sentences around them, so no
// character class separates the name from its sentence. Substring containment
// asks the question that actually matters — is there a real design in here —
// and cannot false-fail on punctuation.
for (const c of cases) {
  const hasReal = [...ACTIVE_DESIGNS].some((name) => c.prompt.includes(name));
  if (hasReal) { pass++; console.log("ok:", `[${c.id}] names a real Danville design`); continue; }
  // Something design-shaped that is not a real design is the regression this
  // check exists for; a prompt with no design at all just needs a declared why.
  assert(!/\bCL3\b/.test(c.prompt),
    `[${c.id}] names a CL3 design that is NOT one of Danville's 21 active designs`);
  assert(DESIGNLESS_OK.has(c.id),
    `[${c.id}] names no design, and says why in DESIGNLESS_OK`);
}

// --- the two Danville-only cases are present and labelled --------------------
// These are the reason the count is 24 and not 22. If one is ever removed, the
// count assertion above fails and this says which behaviour went with it.
for (const id of ["no-design-va-recorded", "design-components-are-not-stockpiles"]) {
  const c = cases.find((x) => x.id === id);
  assert(!!c, `Danville-only case "${id}" is present`);
  assert(c && /DANVILLE-ONLY/.test(c.why),
    `Danville-only case "${id}" says so in its why, so the count stays explicable`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
