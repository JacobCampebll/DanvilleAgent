// Danville plant-rule tests. Re-authored against Danville materials and designs
// per brief 3.3 / 3.9 — BT3's fixtures (Haydon dolomite, the 0.38B at 54%) do
// not exist here, so copying them would have tested nothing.
//
//   node tests/plant_rules.test.mjs
import * as pr from "../netlify/functions/lib/plant_rules.mjs";

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log("ok:", label); }
  else { fail++; console.log("FAIL:", label); }
}

// Danville material ids, from location_materials where location_id = 4.
// Source quarry is part of the identity: the same SIZE comes from several
// quarries and only Haydon Bardstown's are dolomite.
const DOL_8 = 5, DOL_10W = 4, DOL_10U = 3;   // Haydon Bardstown (dolomite)
const NAT_SAND = 15;                          // Watson Gravel
const CCI = 58;                               // Caldwell Stone WASHED #10 (limestone)
const CALDWELL_10 = 50, DIX_RIVER_10 = 16;    // the other two #10 limestones
const LS_10 = DIX_RIVER_10, LS_57 = 57, FINE_RAP = 44;
const bin = (material_id, agg_type, percent) => ({ material_id, agg_type, percent });

// --- the constants Jake confirmed carry over from BT3 (brief 3.7 items 1-2) ---
assert(pr.MIN_BIN_PCT === 10, "MIN_BIN_PCT is 10");
assert(pr.MAX_NATURAL_SAND_PCT === 15, "MAX_NATURAL_SAND_PCT is 15");
assert(pr.MIN_PRC_PCT === 70, "MIN_PRC_PCT is 70");

// --- classification is by material id, not by name (brief 3.7 item 3) --------
assert(pr.isPolishResistant(bin(DOL_8, "Dolomite #8's", 30)) === true, "dolomite #8 counts");
assert(pr.isPolishResistant(bin(DOL_10W, "Dol. #10's Washed", 20)) === true, "dolomite #10 washed counts");
assert(pr.isPolishResistant(bin(DOL_10U, "Dol. #10's Unwashed", 20)) === true, "dolomite #10 unwashed counts");
assert(pr.isPolishResistant(bin(NAT_SAND, "Natural Sand", 10)) === true, "natural sand counts");
assert(pr.isPolishResistant(bin(LS_10, "#10", 20)) === false, "limestone does not count");
assert(pr.isPolishResistant(bin(FINE_RAP, "Fine RAP", 13)) === false, "RAP does not count");

// THE CCI CASE — the golden case brief 3.7 asks for. CCI is Caldwell Stone's
// washed #10 limestone (Jake, 2026-08-31), so it fails the polish-resistant test
// for the ordinary reason rather than a special one. Still worth locking: the
// label "CCI" does not read as limestone to anyone who has not been told, and a
// blend leaning on it clears 70% if it is miscounted and fails if it is not.
{
  const withCci = [
    bin(DOL_8, "Dolomite #8's", 40),
    bin(CCI, "CCI", 35),
    bin(NAT_SAND, "Natural Sand", 10),
    bin(LS_10, "#10", 15),
  ];
  assert(pr.isPolishResistant(bin(CCI, "CCI", 35)) === false, "CCI does NOT count toward PRC");
  assert(pr.prcPercent(withCci) === 50, "PRC excluding CCI = 50 (would read 85 if CCI counted)");
  const v = pr.validateBinPercents(withCci, null, { mix_designation: "CL3 0.38A 64-22 Surface" });
  const hit = v.violations.find((x) => x.rule === "min_prc_pct");
  assert(!!hit, "an A mix leaning on CCI is a PRC VIOLATION, not a pass");
  assert(hit && /CCI/.test(hit.message), "the violation message names CCI as not counting");
}

// CCI stays excluded even if materials.rock is later changed to dolomite —
// the exclusion is by id and explicit, not an emergent property of a pattern.
assert(pr.POLISH_RESISTANT_EXCLUDED_MATERIAL_IDS.has(CCI), "CCI is excluded by id, explicitly");
assert(pr.POLISH_RESISTANT_MATERIAL_IDS.has(CCI) === false, "CCI is not in the allowlist");

// Danville has THREE #10 limestones. All three fail, whichever quarry they came
// from — and Haydon's #10, the same size designation, passes. A size label alone
// does not decide this; the source does.
assert(pr.isPolishResistant(bin(CALDWELL_10, "#10", 20)) === false, "Caldwell #10 does not count");
assert(pr.isPolishResistant(bin(DIX_RIVER_10, "#10", 20)) === false, "Dix River #10 does not count");
assert(pr.isPolishResistant(bin(CCI, "CCI", 20)) === false, "Caldwell washed #10 (CCI) does not count");
assert(pr.isPolishResistant(bin(DOL_10W, "Dol. #10's Washed", 20)) === true,
  "Haydon #10 DOES count - identical size, different quarry, different rock");

// --- the A-mix gate, on Danville's real design names -------------------------
assert(pr.isAMix("CL3 0.38A 64-22 Surface") === true, "Danville 0.38A is an A mix");
assert(pr.isAMix("CL3 0.50A 64-22 Binder") === true, "Danville 0.50A is an A mix");
assert(pr.isAMix("CL3 0.38D 64-22 Fine Surface") === false, "0.38D is not an A mix");
assert(pr.isAMix("CL3 0.38D 64-22 NS State Surface") === false, "0.38D NS variant is not an A mix");
assert(pr.isAMix("Dolomite #8's Class A") === false, "'Class A' aggregate is not an A mix");

// --- the floor only applies where it should ----------------------------------
{
  const legal = [bin(DOL_8, "Dolomite #8's", 45), bin(DOL_10W, "Dol. #10's Washed", 25),
                 bin(LS_10, "#10", 17), bin(FINE_RAP, "Fine RAP", 13)];
  assert(pr.prcPercent(legal) === 70, "a legal A-mix blend reads exactly 70");
  const at70 = pr.validateBinPercents(legal, null, { mix_designation: "CL3 0.38A 64-22 Surface" });
  assert(!at70.violations.find((x) => x.rule === "min_prc_pct"), "exactly 70% passes (floor is inclusive)");

  const short = [bin(DOL_8, "Dolomite #8's", 40), bin(LS_10, "#10", 47), bin(FINE_RAP, "Fine RAP", 13)];
  const onD = pr.validateBinPercents(short, null, { mix_designation: "CL3 0.38D 64-22 Fine Surface" });
  assert(!onD.violations.find((x) => x.rule === "min_prc_pct"), "the floor does not apply to a D mix");
  const unknown = pr.validateBinPercents(short, null, {});
  assert(!unknown.violations.find((x) => x.rule === "min_prc_pct"),
    "unknown designation stays silent rather than inventing a violation");
}

// --- unclassifiable bins: warn, never assert a floor we cannot compute -------
// Danville's mix_components carries NO material_id (0 of 79 rows), so design
// bins arrive unresolved. Guessing permissively would clear an illegal mix;
// guessing strictly would invent a violation. We report the gap instead.
{
  const typed = [{ agg_type: "Dolomite #8's", percent: 45 }, { agg_type: "#10", percent: 42 },
                 { agg_type: "Fine RAP", percent: 13 }];
  assert(pr.classifyPolishResistant(typed[0]) === null, "a bin with no material_id is indeterminate, not false");
  const v = pr.validateBinPercents(typed, null, { mix_designation: "CL3 0.38A 64-22 Surface" });
  assert(!v.violations.find((x) => x.rule === "min_prc_pct"), "no fabricated PRC violation on unresolved bins");
  const warn = v.warnings.find((x) => x.rule === "prc_indeterminate");
  assert(!!warn, "the skipped PRC check is surfaced as a warning");
  assert(warn && /lower bound, not a pass/.test(warn.message), "the warning says it is not a pass");
}

// --- bin floor + natural sand cap -------------------------------------------
{
  const belowFloor = [bin(DOL_8, "Dolomite #8's", 87), bin(NAT_SAND, "Natural Sand", 6),
                      bin(LS_10, "#10", 7)];
  const v = pr.validateBinPercents(belowFloor, null, {});
  assert(v.violations.filter((x) => x.rule === "min_bin_pct").length === 2, "both sub-10% bins flagged");

  const zeroed = [bin(DOL_8, "Dolomite #8's", 90), bin(LS_10, "#10", 10), bin(NAT_SAND, "Natural Sand", 0)];
  assert(pr.validateBinPercents(zeroed, null, {}).ok === true, "0% is legal — that drops the product");

  const tooMuchSand = [bin(DOL_8, "Dolomite #8's", 60), bin(NAT_SAND, "Natural Sand", 22),
                       bin(LS_10, "#10", 18)];
  const sv = pr.validateBinPercents(tooMuchSand, null, {});
  assert(!!sv.violations.find((x) => x.rule === "max_natural_sand"), "natural sand over 15% flagged");

  // …and the cap still works on a hand-typed bin with no id (name fallback)
  const typedSand = [{ agg_type: "Natural Sand", percent: 20 }, { agg_type: "#10", percent: 80 }];
  assert(!!pr.validateBinPercents(typedSand, null, {}).violations.find((x) => x.rule === "max_natural_sand"),
    "sand cap still enforced when the bin has no material_id");
}

// --- the contract bailey_calc.mjs depends on (it is copied byte-identical) ---
assert(typeof pr.prcPercent([bin(DOL_8, "d", 10)]) === "number", "prcPercent returns a NUMBER");
assert(typeof pr.isNaturalSand(bin(NAT_SAND, "Natural Sand", 5)) === "boolean", "isNaturalSand returns a BOOLEAN");
assert(typeof pr.isPolishResistant(bin(DOL_8, "d", 5)) === "boolean", "isPolishResistant returns a BOOLEAN");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
