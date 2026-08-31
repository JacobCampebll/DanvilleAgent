// =============================================================================
// DBT (Danville) plant rules for blend / bin recommendations
// -----------------------------------------------------------------------------
// Ported from BT3 (boonesboroagent @ f28ee70). The validation logic is BT3's,
// unchanged where it can be -- it was paid for by real misses. Two things differ:
//
//   1. HOW a bin is classified as polish-resistant. BT3 pattern-matched the
//      aggregate description string. Danville uses an explicit allowlist of
//      material ids (Jake's ruling, brief 3.7 item 3).
//   2. The PRC rule now declines to fire when it cannot classify every bin,
//      instead of guessing. See validateBinPercents.
//
// THE EXPORTED SHAPES ARE PART OF THE CONTRACT. bailey_calc.mjs is copied from
// BT3 byte-identical and calls prcPercent() as a NUMBER and isNaturalSand() /
// isPolishResistant() as BOOLEANS. Changing those return types silently breaks
// the calculator (NaN in the PRC readout, skipped natural-sand cap). If you need
// richer output, add a new function -- see prcDetail() / classifyPolishResistant().
//
// - Active bins (pct > 0) should stay >= MIN_BIN_PCT (10%)
// - 0% is allowed = remove that product from the blend
// - Natural sand <= MAX_NATURAL_SAND_PCT (15%)
// - Design bins already under 10% may be held or zeroed, not cut further
// =============================================================================

// Confirmed by Jake 2026-08-31 (brief 3.7 items 1-2): both carry over from BT3
// unchanged. These encode plant hardware / convention, not a spec floor.
export const MIN_BIN_PCT = 10;
export const MAX_NATURAL_SAND_PCT = 15;

// KYTC polish-resistant minimum. Applies ONLY to "A" mixes (0.38A, 0.50A ...).
// This one IS a spec floor, so it carries statewide; Danville runs both a
// CL3 0.38A 64-22 Surface and a CL3 0.50A 64-22 Binder, so it is live here.
export const MIN_PRC_PCT = 70;

// -----------------------------------------------------------------------------
// Polish-resistant classification -- allowlist by material id, NOT by pattern.
// -----------------------------------------------------------------------------
// Jake's ruling (brief 3.7 item 3): dolomite counts, natural sand counts,
// "CCI" does NOT count -- regardless of how materials.rock classifies it.
//
// Why an id allowlist instead of BT3's regex on the description string: a
// pattern broad enough to catch every dolomite variant will eventually catch a
// future material that must not count, silently, with no test failing. An
// allowlist fails the other way -- a new material is excluded until someone adds
// it here on purpose. That is the direction we want to fail in.
//
// Resolved against location_materials for location_id = 4 on 2026-08-31. Source
// quarry is part of the identity here, not decoration -- Danville draws the same
// SIZE from several quarries, and only Haydon's are dolomite.
export const POLISH_RESISTANT_MATERIAL_IDS = new Set([
  3,  // Dol. #10's Unwashed  -- Haydon Bardstown   (rock = dolomite)
  4,  // Dol. #10's Washed    -- Haydon Bardstown   (rock = dolomite)
  5,  // Dolomite #8's        -- Haydon Bardstown   (rock = dolomite)
  15, // Natural Sand         -- Watson Gravel      (rock = gravel; counts, per BT3 + KYTC)
]);

// Explicitly excluded, so the answer is written down rather than inferred.
//
// What "CCI" actually is (Jake, 2026-08-31): "Rogers only ships 10s, they don't
// make a cci. Someone randomly named it CCI even though it was still 10s."
// So it is Rogers Group at Caldwell Stone's #10 limestone under a made-up name.
//
// Migration 0075 (2026-08-31) deactivated Danville's offer of it, taking the
// plant from 13 stockpiles to 12. It is NOT deleted and NOT gone from the data:
// 13 gradation tests and 3 bin rows still point at material 58, three of those
// bins from the last week of August. A historical sample can therefore still
// name it, which is why this entry has to stay.
//
// The #10 limestones Danville has drawn on:
//
//   id 50  #10   Rogers Group at Caldwell Stone  (offered)
//   id 58  CCI   Rogers Group at Caldwell Stone  (RETIRED by 0075; same pile as 50)
//   id 16  #10   Dix River Quarry                (offered)
//
// So it does not count toward the polish-resistant fraction for the ordinary
// reason: it is limestone. It is listed here anyway because the string "CCI" is
// opaque -- it does not read as a limestone #10 to anyone who has not been told,
// and the risk is a future maintainer assuming it must be something dolomitic
// and adding it to the allowlist above. This entry is the written answer to that
// question. It is belt-and-braces, not load-bearing: 58 was never in the
// allowlist, so removing this set would not change a single result.
export const POLISH_RESISTANT_EXCLUDED_MATERIAL_IDS = new Set([
  58, // CCI = Caldwell Stone washed #10, limestone. Does not count.
]);

// Natural sand, for the MAX_NATURAL_SAND_PCT cap.
export const NATURAL_SAND_MATERIAL_IDS = new Set([
  15, // Natural Sand
]);

export const PLANT_RULES_SUMMARY = [
  `Active bins must be >=${MIN_BIN_PCT}% (0% is OK -- that means drop the product).`,
  `Natural sand must not exceed ${MAX_NATURAL_SAND_PCT}%.`,
  `On "A" mixes (0.38A, 0.50A) polish-resistant aggregate -- dolomite + natural sand only, not limestone, not CCI and not RAP -- must total at least ${MIN_PRC_PCT}%.`,
  "If the design already has a bin under 10%, you may hold it or set it to 0%, but do not cut it further between 0 and 10.",
].join(" ");

// "A" mix = the letter suffix on the nominal size (0.38A, 0.50A). Requires the
// digits so an aggregate called "Dolomite #8's Class A" can never be mistaken for one.
export function isAMix(designation) {
  return /\d\.\d{1,2}\s*A\b/i.test(String(designation || ""));
}

function materialId(bin) {
  const raw = bin?.material_id ?? bin?.materialId ?? null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isRapBin(bin) {
  return /\brap\b/i.test(String(bin?.agg_type || bin?.type || ""));
}

/**
 * Tri-state polish-resistant classification: true | false | null.
 * null = cannot classify (the bin arrived with no material_id, which happens
 * when a tech types bins into the Mix change form by hand). We deliberately do
 * NOT fall back to string matching: guessing in the permissive direction would
 * silently clear a 70% floor on an illegal mix. Callers surface it instead.
 */
export function classifyPolishResistant(bin) {
  const id = materialId(bin);
  if (id == null) return null;
  if (POLISH_RESISTANT_EXCLUDED_MATERIAL_IDS.has(id)) return false;
  return POLISH_RESISTANT_MATERIAL_IDS.has(id);
}

// Boolean form -- BT3's contract. Unclassifiable reads as false (does not count).
export function isPolishResistant(bin) {
  return classifyPolishResistant(bin) === true;
}

/**
 * Natural sand. Id allowlist first; falls back to BT3's name test when the bin
 * has no id. The fallback is kept HERE and not on polish-resistance on purpose:
 * Jake's ruling constrains the PRC set, and leaving the 15% cap unenforced for
 * hand-typed bins would be a regression against BT3 with nothing gained.
 */
export function isNaturalSand(bin) {
  const id = materialId(bin);
  if (id != null) return NATURAL_SAND_MATERIAL_IDS.has(id);
  if (isRapBin(bin)) return false;
  const t = String(bin?.agg_type || bin?.type || "").toLowerCase();
  if (/natural\s*sand/.test(t)) return true;
  if (/\bsand\b/.test(t) && !/manuf|#10|#11|stone|lime|silt|anti/.test(t)) return true;
  return false;
}

/** Polish-resistant total as a NUMBER -- BT3's contract. */
export function prcPercent(bins) {
  return prcDetail(bins).percent;
}

/**
 * Richer PRC readout: the total, plus every active bin we could not classify.
 * An unclassifiable bin is EXCLUDED from the total, so the number understates
 * rather than overstates -- and `indeterminate` is how the caller knows the
 * difference between "genuinely 50%" and "50% that we cannot vouch for".
 */
export function prcDetail(bins) {
  const list = Array.isArray(bins) ? bins : [];
  let pct = 0;
  const indeterminate = [];
  for (const b of list) {
    const p = Number(b.percent ?? b.pct);
    if (!Number.isFinite(p) || p <= 0) continue;
    const verdict = classifyPolishResistant(b);
    if (verdict === true) pct += p;
    else if (verdict === null) {
      indeterminate.push({ agg_type: b.agg_type || b.type || "bin", percent: p });
    }
  }
  return { percent: Math.round(pct * 10) / 10, indeterminate };
}

function binKey(b) {
  return String(b.material_code ?? "") + "|" + String(b.agg_type || b.type || "").toLowerCase();
}

/**
 * @param {Array} bins - proposed or current list
 * @param {Array|null} baseline - design bins for grandfathering under-floor holds
 */
export function validateBinPercents(bins, baseline = null, opts = {}) {
  const violations = [];
  const warnings = [];
  if (!Array.isArray(bins) || !bins.length) {
    return { ok: true, violations, warnings, summary: "No bins to check." };
  }

  const baseMap = new Map();
  if (Array.isArray(baseline)) {
    for (const b of baseline) {
      const p = Number(b.percent ?? b.pct);
      if (Number.isFinite(p)) baseMap.set(binKey(b), p);
    }
  }

  let total = 0;
  for (const b of bins) {
    const pct = Number(b.percent ?? b.pct);
    if (!Number.isFinite(pct) || pct < 0) continue;
    // 0% = product removed -- always allowed
    if (pct === 0) continue;

    total += pct;
    const label = b.agg_type || b.type || b.material_code || "bin";
    const basePct = baseMap.has(binKey(b)) ? baseMap.get(binKey(b)) : null;

    if (pct > 0 && pct < MIN_BIN_PCT) {
      // Grandfather: design already under floor and tech held it
      const heldUnderFloor =
        basePct != null && basePct > 0 && basePct < MIN_BIN_PCT && pct >= basePct - 0.05 && pct < MIN_BIN_PCT;
      if (heldUnderFloor) {
        warnings.push({
          rule: "grandfather_under_floor",
          percent: pct,
          agg_type: label,
          message: `${label} held at ${pct}% (design ${basePct}% was already under ${MIN_BIN_PCT}% floor). Prefer >=${MIN_BIN_PCT}% or 0% long-term.`,
        });
      } else if (basePct != null && basePct >= MIN_BIN_PCT && pct < MIN_BIN_PCT) {
        violations.push({
          rule: "min_bin_pct",
          limit: MIN_BIN_PCT,
          percent: pct,
          agg_type: label,
          material_code: b.material_code ?? null,
          message: `${label}: don't cut below ${MIN_BIN_PCT}% (proposed ${pct}%, was ${basePct}%). Use 0% to remove, or keep >=${MIN_BIN_PCT}%.`,
        });
      } else if (basePct == null || basePct === 0) {
        violations.push({
          rule: "min_bin_pct",
          limit: MIN_BIN_PCT,
          percent: pct,
          agg_type: label,
          material_code: b.material_code ?? null,
          message: `${label} at ${pct}%: new/active bins must be >=${MIN_BIN_PCT}% (or 0% to omit).`,
        });
      } else if (basePct != null && pct < basePct - 0.05 && basePct < MIN_BIN_PCT) {
        violations.push({
          rule: "do_not_cut_further_below_floor",
          percent: pct,
          agg_type: label,
          message: `${label} is already under ${MIN_BIN_PCT}% (${basePct}%); don't cut further to ${pct}%. Hold or set to 0%.`,
        });
      } else {
        violations.push({
          rule: "min_bin_pct",
          limit: MIN_BIN_PCT,
          percent: pct,
          agg_type: label,
          material_code: b.material_code ?? null,
          message: `${label} at ${pct}% is below the plant floor of ${MIN_BIN_PCT}% (0% to remove is OK).`,
        });
      }
    }

    if (isNaturalSand(b) && pct > MAX_NATURAL_SAND_PCT) {
      violations.push({
        rule: "max_natural_sand",
        limit: MAX_NATURAL_SAND_PCT,
        percent: pct,
        agg_type: label,
        material_code: b.material_code ?? null,
        message: `Natural sand at ${pct}% exceeds the plant cap of ${MAX_NATURAL_SAND_PCT}%.`,
      });
    }
  }

  // PRC minimum -- only on A mixes, and only when we were told which mix this is.
  // Staying silent when the designation is unknown is deliberate: inventing a
  // violation on a B/D mix would be worse than not checking.
  const designation = opts.mix_designation ?? opts.designation ?? opts.mixDesignation ?? null;
  if (designation && isAMix(designation)) {
    const { percent: prc, indeterminate } = prcDetail(bins);
    if (indeterminate.length) {
      // Danville change vs BT3: we will not assert a 70% floor we cannot compute.
      // Bins sourced from test_bin_percentages always carry material_id, so this
      // only fires on hand-typed bins -- where a false violation would send a
      // tech chasing a spec problem that isn't there, and a false pass would
      // clear an illegal mix. Report the gap instead of guessing either way.
      warnings.push({
        rule: "prc_indeterminate",
        limit: MIN_PRC_PCT,
        counted_percent: prc,
        unclassified: indeterminate,
        message:
          `Polish-resistant check SKIPPED for ${designation}: ` +
          `${indeterminate.map((i) => `${i.agg_type} (${i.percent}%)`).join(", ")} ` +
          `arrived without a material id, so the ${MIN_PRC_PCT}% floor cannot be verified. ` +
          `Counted ${prc}% from identified bins only -- treat as a lower bound, not a pass.`,
      });
    } else if (prc < MIN_PRC_PCT) {
      violations.push({
        rule: "min_prc_pct",
        limit: MIN_PRC_PCT,
        percent: prc,
        message:
          `Polish-resistant aggregate is ${prc}% -- an "A" mix (${designation}) requires at least ` +
          `${MIN_PRC_PCT}%. Only dolomite and natural sand count toward it; limestone, CCI and RAP do not. ` +
          `Raise dolomite and/or natural sand by ${Math.round((MIN_PRC_PCT - prc) * 10) / 10} points.`,
      });
    }
  }

  if (total > 0 && Math.abs(total - 100) > 0.6) {
    warnings.push({
      rule: "bins_sum",
      total: Math.round(total * 10) / 10,
      message: `Active bins sum to ${Math.round(total * 10) / 10}% (expect ~100% including zeros omitted).`,
    });
  }

  const ok = violations.length === 0;
  return {
    ok,
    violations,
    warnings,
    summary: ok
      ? `Plant bin rules OK (active >=${MIN_BIN_PCT}% or 0%; natural sand <=${MAX_NATURAL_SAND_PCT}%).`
      : `Plant bin rules violated (${violations.length}): ${violations.map((v) => v.message).join(" ")}`,
    rules: {
      min_bin_pct: MIN_BIN_PCT,
      max_natural_sand_pct: MAX_NATURAL_SAND_PCT,
      min_prc_pct_on_a_mixes: MIN_PRC_PCT,
      zero_allowed: true,
    },
  };
}

export function validateBinMove(currentBins, proposedBins, opts = {}) {
  // Proposed checked against design (current) for grandfathering
  const proposed = validateBinPercents(proposedBins, currentBins, opts);
  const current = validateBinPercents(currentBins, null, opts);

  return {
    ok: proposed.ok,
    current,
    proposed,
    violations: proposed.violations,
    warnings: [...current.warnings, ...proposed.warnings],
    summary: proposed.summary,
    rules: proposed.rules,
  };
}

export default {
  MIN_BIN_PCT,
  MAX_NATURAL_SAND_PCT,
  MIN_PRC_PCT,
  POLISH_RESISTANT_MATERIAL_IDS,
  POLISH_RESISTANT_EXCLUDED_MATERIAL_IDS,
  NATURAL_SAND_MATERIAL_IDS,
  isAMix,
  isPolishResistant,
  classifyPolishResistant,
  prcPercent,
  prcDetail,
  PLANT_RULES_SUMMARY,
  validateBinPercents,
  validateBinMove,
  isNaturalSand,
};
