// =============================================================================
// Deterministic Bailey Method / plant blend calculator
// -----------------------------------------------------------------------------
// Pure functions — no LLM, no network. Used by the bailey_calc tool so the agent
// cites real numbers for control sieves, ratios, sieve deltas, VMA sensitivity
// rules-of-thumb, and AC→Va estimates (ACVC / plant rule).
//
// Source: William J. Pine Bailey Method course (see data/bailey_kb.mjs).
// Plant rule (lab-confirmed BT3): ±0.1% AC ≈ ∓0.22–0.25% Va ≈ ACVC 2.25.
// Bin floors: min 10% any bin; natural sand max 15% (see plant_rules.mjs).
// =============================================================================

import {
  validateBinPercents,
  validateBinMove,
  MIN_PRC_PCT,
  isAMix,
  prcPercent,
  PLANT_RULES_SUMMARY,
  MIN_BIN_PCT,
  MAX_NATURAL_SAND_PCT,
  isNaturalSand,
} from "./plant_rules.mjs";

/** Standard sieve set used on BT3 mix packs / lab sheets (mm → display label). */
export const SIEVE_MM_TO_LABEL = {
  "50.0": '2"',
  "37.5": '1 1/2"',
  "25.0": '1"',
  "19.0": '3/4"',
  "12.5": '1/2"',
  "9.5": '3/8"',
  "4.75": "#4",
  "2.36": "#8",
  "1.18": "#16",
  "0.6": "#30",
  "0.3": "#50",
  "0.15": "#100",
  "0.075": "#200",
};

const LABEL_TO_MM = (() => {
  const m = new Map();
  for (const [mm, lab] of Object.entries(SIEVE_MM_TO_LABEL)) {
    m.set(lab.toLowerCase(), mm);
    m.set(mm, mm);
    m.set(String(parseFloat(mm)), mm);
  }
  // common aliases
  const aliases = {
    '2"': "50.0",
    '2 in': "50.0",
    '1.5"': "37.5",
    '1 1/2"': "37.5",
    '1-1/2"': "37.5",
    '1"': "25.0",
    '3/4"': "19.0",
    '0.75"': "19.0",
    '1/2"': "12.5",
    '0.5"': "12.5",
    '3/8"': "9.5",
    '0.375"': "9.5",
    "#4": "4.75",
    "no.4": "4.75",
    "no. 4": "4.75",
    "#8": "2.36",
    "no.8": "2.36",
    "no. 8": "2.36",
    "#16": "1.18",
    "#30": "0.6",
    "#50": "0.3",
    "#100": "0.15",
    "#200": "0.075",
    "200": "0.075",
  };
  for (const [k, v] of Object.entries(aliases)) m.set(k.toLowerCase(), v);
  return m;
})();

/** Bailey control-sieve table by NMAS (mm) — course binder summary sheet. */
const CONTROL_BY_NMAS = {
  37.5: { half: 19.0, pcs: 9.5, scs: 2.36, tcs: 0.6 },
  25.0: { half: 12.5, pcs: 4.75, scs: 1.18, tcs: 0.3 },
  19.0: { half: 9.5, pcs: 4.75, scs: 1.18, tcs: 0.3 },
  12.5: { half: 6.35, pcs: 2.36, scs: 0.6, tcs: 0.15 }, // half is non-standard
  9.5: { half: 4.75, pcs: 2.36, scs: 0.6, tcs: 0.15 },
  4.75: { half: 2.36, pcs: 1.18, scs: 0.3, tcs: 0.075 },
};

/** Suggested CA ratio ranges (coarse-graded / OLD CA for fine-graded). */
const CA_RATIO_RANGE = {
  37.5: [0.8, 0.95],
  25.0: [0.7, 0.85],
  19.0: [0.6, 0.75],
  12.5: [0.5, 0.65],
  9.5: [0.4, 0.55],
  4.75: [0.3, 0.45],
};

/** VMA sensitivity midpoints: how much change ≈ 1% VMA (direction notes in notes). */
const VMA_SENSITIVITY = {
  coarse: {
    pcs_pct_per_vma: 4, // Δ%PCS ≈ 4 → ≈1% VMA (range 3–5); ↑PCS often ↓CA volume → depends
    ca_ratio_per_vma: 0.2, // ↑CA ratio → ↑VMA
    fac_per_vma: 0.05, // ↑FAc → ↓VMA (to dip)
    faf_per_vma: 0.05, // ↑FAf → ↓VMA (to dip)
    fac_most_influence: true,
  },
  fine: {
    pcs_pct_per_vma: 6, // Original PCS; ↑%PCS (more fine) → ↑VMA on fine side
    ca_ratio_per_vma: 0.35, // New CA
    fac_per_vma: 0.05, // New FAc
    faf_per_vma: 0.05, // New FAf
    fac_most_influence: true,
  },
  sma: {
    pcs_pct_per_vma: 2,
    ca_ratio_per_vma: 0.2,
    fac_per_vma: 0.1,
    faf_per_vma: 0.1,
    fac_most_influence: false, // PCS / CA volume most influence for SMA
  },
};

const DEFAULT_ACVC = 2.25; // AC volume correction; plant: ±0.1% AC ≈ ∓0.225% Va
const r3 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 1000) / 1000);
const r2 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const r1 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);

/**
 * Confidence band for hypo Va / predict numbers shown to techs.
 * Not a statistical CI — a plant-facing honesty score from data quality + lever type.
 *
 * @param {object} o
 * @param {number} [o.percent_covered] stockpile mass % with sieves
 * @param {number} [o.missing_count] bins without gradation
 * @param {string} [o.stockpile_freshness] text from blend (may include STALE)
 * @param {number|null} [o.packing_delta_va] approx ΔVa from packing alone
 * @param {number|null} [o.ac_delta] proposed or measured AC change (pts)
 * @param {boolean} [o.packing_available] false if blend/RoT could not run
 * @param {string} [o.context] short label e.g. "suggest_moves"
 */
export function predictionConfidence(o = {}) {
  let score = 48;
  const reasons = [];
  const covered = Number(o.percent_covered);
  const missing = Number(o.missing_count) || 0;
  const fresh = String(o.stockpile_freshness || "");
  const packD = o.packing_delta_va != null ? Math.abs(Number(o.packing_delta_va)) : null;
  const acD = o.ac_delta != null ? Math.abs(Number(o.ac_delta)) : null;
  const packingAvailable = o.packing_available !== false;
  const hasAc = acD != null && acD >= 0.05;
  const hasPack = packD != null && packD >= 0.08 && packingAvailable;

  if (Number.isFinite(covered)) {
    if (covered >= 95 && missing === 0) {
      score += 22;
      reasons.push("full stockpile coverage");
    } else if (covered >= 70) {
      score += 10;
      reasons.push("most stockpiles covered (" + r1(covered) + "%)");
    } else if (covered >= 40) {
      score -= 5;
      reasons.push("partial stockpile coverage (" + r1(covered) + "%)");
    } else {
      score -= 18;
      reasons.push("low stockpile coverage (" + r1(covered) + "%)");
    }
  } else {
    score -= 8;
    reasons.push("stockpile coverage unknown");
  }

  if (/STALE/i.test(fresh)) {
    score -= 14;
    reasons.push("stale stockpile sieves");
  } else if (Number.isFinite(covered) && covered >= 70) {
    score += 4;
    reasons.push("stockpiles not flagged stale");
  }

  if (hasAc && !hasPack) {
    score += 22;
    reasons.push("mostly binder lever (ACVC / plant AC rule)");
  } else if (hasAc && hasPack) {
    score += 6;
    reasons.push("packing RoT + AC");
  } else if (hasPack) {
    score -= 4;
    reasons.push("packing RoT only");
  } else if (!packingAvailable) {
    score -= 12;
    reasons.push("packing math incomplete");
  }

  if (hasPack && packD >= 1.0) {
    score -= 12;
    reasons.push("large packing ΔVa (magnitude rough)");
  } else if (hasPack && packD < 0.35) {
    score += 6;
    reasons.push("modest packing change");
  }

  if (missing > 0) {
    score -= Math.min(12, missing * 3);
    reasons.push(missing + " bin(s) missing sieves");
  }

  score = Math.max(8, Math.min(92, Math.round(score)));
  const level = score >= 68 ? "high" : score >= 42 ? "medium" : "low";
  const levelLabel = level === "high" ? "High" : level === "medium" ? "Medium" : "Low";
  const summary =
    levelLabel +
    " confidence — " +
    (reasons[0] || "advisory Bailey/AC estimate") +
    (reasons[1] ? "; " + reasons[1] : "") +
    ". Confirm on next sample.";

  return {
    level,
    label: levelLabel,
    score,
    reasons: reasons.slice(0, 5),
    summary,
    how_to_read:
      "High ≈ AC-heavy or small packing move with full fresh stockpiles. Medium ≈ typical packing RoT. Low ≈ incomplete/stale piles or large packing swing. Not a lab guarantee.",
  };
}

function mmKey(mm) {
  const n = parseFloat(mm);
  if (!Number.isFinite(n)) return null;
  // normalize to one of our keys when close
  for (const k of Object.keys(SIEVE_MM_TO_LABEL)) {
    if (Math.abs(parseFloat(k) - n) < 1e-6) return k;
  }
  // keep one-decimal or integer-ish
  if (Number.isInteger(n) || Math.abs(n - Math.round(n)) < 1e-9) return String(n.toFixed(1));
  return String(n);
}

/**
 * Normalize a free-form gradation object to { "4.75": 62.2, ... } (% passing).
 * Accepts labels (#4, 3/8"), mm keys, numbers.
 */
export function normalizeGradation(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const num = typeof v === "number" ? v : parseFloat(String(v).replace(/%/g, ""));
    if (!Number.isFinite(num)) continue;
    const key = String(k).trim().toLowerCase();
    let mm = LABEL_TO_MM.get(key);
    if (!mm) {
      // try stripping "mm"
      const cleaned = key.replace(/\s*mm\s*$/i, "").trim();
      mm = LABEL_TO_MM.get(cleaned) || mmKey(cleaned);
    }
    if (!mm) continue;
    const canon = mmKey(mm) || mm;
    out[canon] = num;
  }
  return out;
}

/** % passing at sieve mm; linear-interpolate in log-sieve space if missing. */
export function passingAt(grad, sieveMm) {
  const target = parseFloat(sieveMm);
  if (!Number.isFinite(target)) return null;
  const canon = mmKey(target);
  if (canon && grad[canon] != null && Number.isFinite(grad[canon])) return grad[canon];
  // exact float key
  for (const [k, v] of Object.entries(grad)) {
    if (Math.abs(parseFloat(k) - target) < 1e-6 && Number.isFinite(v)) return v;
  }
  // interpolate between surrounding sieves
  const pts = Object.entries(grad)
    .map(([k, v]) => [parseFloat(k), v])
    .filter(([mm, v]) => Number.isFinite(mm) && Number.isFinite(v))
    .sort((a, b) => b[0] - a[0]); // coarse → fine
  if (!pts.length) return null;
  if (target >= pts[0][0]) return pts[0][1];
  if (target <= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [mm1, p1] = pts[i];
    const [mm2, p2] = pts[i + 1];
    if (target <= mm1 && target >= mm2) {
      // linear in log(sieve)
      const t = (Math.log(mm1) - Math.log(target)) / (Math.log(mm1) - Math.log(mm2));
      return p1 + t * (p2 - p1);
    }
  }
  return null;
}

/** Closest standard sieve key to a size (mm). Includes 6.35 for 12.5 mm half. */
const CLOSEST_POOL = [
  50, 37.5, 25, 19, 12.5, 9.5, 6.35, 4.75, 2.36, 1.18, 0.6, 0.3, 0.15, 0.075,
];

export function closestSieve(mm) {
  const t = parseFloat(mm);
  let best = CLOSEST_POOL[0];
  let bestD = Math.abs(best - t);
  for (const s of CLOSEST_POOL) {
    const d = Math.abs(s - t);
    if (d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

/**
 * Bailey NMAS: first sieve larger than the first sieve that retains >15%.
 * Falls back to largest sieve with <100% passing if structure is incomplete.
 */
export function baileyNmas(grad) {
  const sieves = Object.keys(SIEVE_MM_TO_LABEL)
    .map(parseFloat)
    .sort((a, b) => b - a); // coarse → fine
  let firstRetain15 = null;
  for (const mm of sieves) {
    const p = passingAt(grad, mm);
    if (p == null) continue;
    const retained = 100 - p;
    if (retained > 15) {
      firstRetain15 = mm;
      break;
    }
  }
  if (firstRetain15 == null) {
    // try 10% variant note
    for (const mm of sieves) {
      const p = passingAt(grad, mm);
      if (p != null && 100 - p > 10) {
        firstRetain15 = mm;
        break;
      }
    }
  }
  if (firstRetain15 == null) return null;
  // first sieve larger than firstRetain15
  const larger = sieves.filter((s) => s > firstRetain15).sort((a, b) => a - b);
  const nmas = larger.length ? larger[0] : firstRetain15;
  // snap to known control table keys when close
  for (const known of Object.keys(CONTROL_BY_NMAS).map(parseFloat)) {
    if (Math.abs(known - nmas) < 0.01) return known;
  }
  return nmas;
}

export function controlSieves(nmasMm) {
  const n = parseFloat(nmasMm);
  if (!Number.isFinite(n)) return null;
  if (CONTROL_BY_NMAS[n]) {
    const c = CONTROL_BY_NMAS[n];
    return {
      nmas_mm: n,
      half_mm: c.half,
      pcs_mm: c.pcs,
      scs_mm: c.scs,
      tcs_mm: c.tcs,
      from_table: true,
    };
  }
  // compute from 0.22 / 0.5 rules
  const half = closestSieve(0.5 * n);
  const pcs = closestSieve(0.22 * n);
  const scs = closestSieve(0.22 * pcs);
  const tcs = closestSieve(0.22 * scs);
  return { nmas_mm: n, half_mm: half, pcs_mm: pcs, scs_mm: scs, tcs_mm: tcs, from_table: false };
}

/**
 * Classify mix type from %PCS vs 0.45-power MDL at PCS.
 * Without CUW this is approximate — override with mix_type when known.
 */
export function classifyMixType(grad, controls) {
  if (!controls) return { mix_type: "unknown", reason: "no control sieves" };
  const pcsP = passingAt(grad, controls.pcs_mm);
  if (pcsP == null) return { mix_type: "unknown", reason: "missing %PCS" };
  const nmas = controls.nmas_mm;
  // MDL % passing at PCS ≈ (PCS/NMAS)^0.45 * 100
  const mdl = Math.pow(controls.pcs_mm / nmas, 0.45) * 100;
  // SMA heuristic: very low PCS passing typically < ~30 for surface SMA — rare at BT3
  if (pcsP < 28 && nmas >= 9.5) {
    return {
      mix_type: "sma_candidate",
      reason: `%PCS ${r1(pcsP)} is low (MDL@PCS≈${r1(mdl)}); confirm SMA vs coarse-graded before using SMA sensitivity.`,
      pct_pcs: r1(pcsP),
      mdl_at_pcs: r1(mdl),
    };
  }
  if (pcsP > mdl) {
    return {
      mix_type: "fine",
      reason: `%PCS ${r1(pcsP)} is above 0.45-power MDL@PCS≈${r1(mdl)} → fine-graded (FA in control).`,
      pct_pcs: r1(pcsP),
      mdl_at_pcs: r1(mdl),
    };
  }
  return {
    mix_type: "coarse",
    reason: `%PCS ${r1(pcsP)} is at/below 0.45-power MDL@PCS≈${r1(mdl)} → coarse-graded (CA interlock).`,
    pct_pcs: r1(pcsP),
    mdl_at_pcs: r1(mdl),
  };
}

export function computeRatios(grad, controls) {
  if (!controls) return { error: "controls required" };
  const half = passingAt(grad, controls.half_mm);
  const pcs = passingAt(grad, controls.pcs_mm);
  const scs = passingAt(grad, controls.scs_mm);
  const tcs = passingAt(grad, controls.tcs_mm);
  const sieves = {
    half: { mm: controls.half_mm, label: labelFor(controls.half_mm), pct_passing: r1(half) },
    pcs: { mm: controls.pcs_mm, label: labelFor(controls.pcs_mm), pct_passing: r1(pcs) },
    scs: { mm: controls.scs_mm, label: labelFor(controls.scs_mm), pct_passing: r1(scs) },
    tcs: { mm: controls.tcs_mm, label: labelFor(controls.tcs_mm), pct_passing: r1(tcs) },
  };
  let ca_ratio = null;
  if (half != null && pcs != null && 100 - half !== 0) {
    ca_ratio = (half - pcs) / (100 - half);
  }
  let fac = null;
  if (scs != null && pcs != null && pcs !== 0) fac = scs / pcs;
  let faf = null;
  if (tcs != null && scs != null && scs !== 0) faf = tcs / scs;

  const caRange = CA_RATIO_RANGE[controls.nmas_mm] || null;
  return {
    sieves,
    ca_ratio: r3(ca_ratio),
    fac_ratio: r3(fac),
    faf_ratio: r3(faf),
    interceptors_pct: half != null && pcs != null ? r1(half - pcs) : null,
    pluggers_pct: half != null ? r1(100 - half) : null,
    ca_ratio_suggested_range: caRange,
    fac_suggested_range: [0.35, 0.5],
    faf_suggested_range: [0.35, 0.5],
    notes: [
      "CA Ratio = (%Half − %PCS) / (100 − %Half)  [interceptors / pluggers]",
      "FAc = %SCS / %PCS",
      "FAf = %TCS / %SCS",
      "Avoid FAc or FAf < 0.40 for field compactability (course guideline).",
    ],
  };
}

function labelFor(mm) {
  const k = mmKey(mm);
  if (k && SIEVE_MM_TO_LABEL[k]) return SIEVE_MM_TO_LABEL[k];
  if (Math.abs(mm - 6.35) < 0.01) return "1/4\" (6.35 mm)";
  return `${mm} mm`;
}

/**
 * Renormalize gradation to the minus-PCS fraction (for New ratios on fine-graded mixes).
 * Passing values become % of material finer than original PCS.
 */
export function finePrimaryBlend(grad, originalPcsMm) {
  const pcsP = passingAt(grad, originalPcsMm);
  if (pcsP == null || pcsP <= 0) return { error: "cannot build fine primary blend — missing/zero %PCS" };
  const out = {};
  for (const [k, v] of Object.entries(grad)) {
    const mm = parseFloat(k);
    if (!Number.isFinite(mm) || !Number.isFinite(v)) continue;
    if (mm >= parseFloat(originalPcsMm) - 1e-9) out[k] = 100;
    else out[k] = (v / pcsP) * 100;
  }
  return { gradation: out, original_pcs_passing: pcsP };
}

/** Sieve-by-sieve delta: sample − design (% passing). Positive = sample finer. */
export function sieveDeltas(design, sample) {
  const keys = new Set([...Object.keys(design), ...Object.keys(sample)]);
  const rows = [];
  for (const k of [...keys].sort((a, b) => parseFloat(b) - parseFloat(a))) {
    const d = design[k];
    const s = sample[k];
    if (d == null && s == null) continue;
    const delta = d != null && s != null ? s - d : null;
    rows.push({
      mm: parseFloat(k),
      label: labelFor(parseFloat(k)),
      design: d != null ? r1(d) : null,
      sample: s != null ? r1(s) : null,
      delta_sample_minus_design: delta != null ? r1(delta) : null,
    });
  }
  return rows;
}

/**
 * Estimate ΔVMA from ratio / PCS changes using Bailey rules-of-thumb.
 * Signs: coarse/fine FAc/FAf ↑ → VMA ↓ (until dip); CA ratio ↑ → VMA ↑;
 * PCS %: for CG, more CA (lower %PCS) tends ↑VMA when leaving the dip toward SMA side;
 * for FG, higher %PCS (more fine) tends ↑VMA.
 * These are directional midpoints — not lab predictions.
 */
export function estimateVmaDeltas(mixType, designRatios, sampleRatios, designPcs, samplePcs) {
  const key = mixType === "sma" || mixType === "sma_candidate" ? "sma" : mixType === "fine" ? "fine" : "coarse";
  const sens = VMA_SENSITIVITY[key];
  const out = { mix_type_used: key, components: [], total_approx_vma: null, caveats: [] };

  const dPcs = designPcs != null && samplePcs != null ? samplePcs - designPcs : null;
  if (dPcs != null && sens.pcs_pct_per_vma) {
    // Fine: ↑%PCS → ↑VMA; Coarse/SMA: ↑%PCS (finer) → ↓VMA (moving left/toward fine side from CA interlock)
    const sign = key === "fine" ? 1 : -1;
    const dv = sign * (dPcs / sens.pcs_pct_per_vma);
    out.components.push({
      lever: key === "fine" ? "Original %PCS" : "%PCS (CA volume proxy)",
      delta_input: r2(dPcs),
      unit: "% passing",
      approx_delta_vma: r2(dv),
      rule: `${sens.pcs_pct_per_vma}% ΔPCS ≈ 1% VMA (${key})`,
    });
  }

  const pair = (name, dVal, sVal, per, vmaSign, note) => {
    if (dVal == null || sVal == null || !per) return;
    const di = sVal - dVal;
    const dv = vmaSign * (di / per);
    out.components.push({
      lever: name,
      delta_input: r3(di),
      unit: "ratio",
      approx_delta_vma: r2(dv),
      rule: note,
    });
  };

  pair(
    key === "fine" ? "New CA ratio" : "CA ratio",
    designRatios.ca_ratio,
    sampleRatios.ca_ratio,
    sens.ca_ratio_per_vma,
    +1,
    `+${sens.ca_ratio_per_vma} CA ratio ≈ +1% VMA`
  );
  pair(
    key === "fine" ? "New FAc" : "FAc",
    designRatios.fac_ratio,
    sampleRatios.fac_ratio,
    sens.fac_per_vma,
    -1,
    `+${sens.fac_per_vma} FAc ≈ −1% VMA (to the dip; beyond dip reverses)`
  );
  pair(
    key === "fine" ? "New FAf" : "FAf",
    designRatios.faf_ratio,
    sampleRatios.faf_ratio,
    sens.faf_per_vma,
    -1,
    `+${sens.faf_per_vma} FAf ≈ −1% VMA (to the dip; beyond dip reverses)`
  );

  // Simple sum is a rough combined signal — ratios are not independent
  const sum = out.components.reduce((a, c) => a + (c.approx_delta_vma || 0), 0);
  out.total_approx_vma = r2(sum);
  out.caveats.push(
    "Components are NOT independent (changing bins moves several levers at once). Use direction + largest component, not the sum as a precise prediction."
  );
  out.caveats.push(
    "Rules-of-thumb assume similar particle shape/texture/strength; stockpile quality shifts are outside this math."
  );
  if (sens.fac_most_influence) {
    out.caveats.push("For dense-graded (fine/coarse), FAc usually has the most influence on VMA of the three ratios.");
  }
  return out;
}

/** Plant / ACVC estimate: ΔVa ≈ −ACVC × ΔAC (total AC % of mix). */
export function estimateVaFromAc(deltaAc, acvc = DEFAULT_ACVC) {
  const d = parseFloat(deltaAc);
  const f = parseFloat(acvc) || DEFAULT_ACVC;
  if (!Number.isFinite(d)) return { error: "delta_ac required" };
  return {
    delta_ac: r2(d),
    acvc: f,
    approx_delta_va: r2(-f * d),
    plant_rule: "±0.1% AC ≈ ∓0.22–0.25% Va (lab-confirmed BT3; ACVC 2.25 mid).",
    notes: [
      "Assumes VMA / aggregate structure fixed — binder volume lever only.",
      "Plant meters RAP binder; targets are total AC — do not double-count RAP binder when RAP % changes.",
      "If voids and dust are BOTH low, check AC/Gmm measurement AND gradation — not AC alone.",
    ],
  };
}

/**
 * Full analysis: design vs sample (optional), ratios, deltas, VMA/AC estimates.
 */
export function analyze(input = {}) {
  const design = normalizeGradation(input.design_gradation || input.design || {});
  const sample = normalizeGradation(input.sample_gradation || input.sample || {});
  const hasDesign = Object.keys(design).length > 0;
  const hasSample = Object.keys(sample).length > 0;
  if (!hasDesign && !hasSample) {
    return { error: "Provide design_gradation and/or sample_gradation (% passing by sieve)." };
  }

  const primary = hasSample ? sample : design;
  const nmas =
    input.nmas_mm != null && Number.isFinite(parseFloat(input.nmas_mm))
      ? parseFloat(input.nmas_mm)
      : baileyNmas(hasDesign ? design : primary);
  if (nmas == null) {
    return { error: "Could not determine NMAS — supply nmas_mm or a fuller gradation." };
  }

  const controls = controlSieves(nmas);
  let mixType = String(input.mix_type || "auto").toLowerCase();
  let classification = classifyMixType(hasDesign ? design : primary, controls);
  if (mixType === "auto" || mixType === "") {
    mixType = classification.mix_type === "sma_candidate" ? "coarse" : classification.mix_type;
    if (mixType === "unknown") mixType = "coarse";
  } else if (["fine", "coarse", "sma"].includes(mixType)) {
    classification = { ...classification, mix_type: mixType, reason: `user override: ${mixType}` };
  }

  const designRatios = hasDesign ? computeRatios(design, controls) : null;
  const sampleRatios = hasSample ? computeRatios(sample, controls) : null;

  // Fine-graded New ratios on minus-PCS primary blend
  let newRatios = null;
  if (mixType === "fine") {
    const baseGrad = hasSample ? sample : design;
    const primaryBlend = finePrimaryBlend(baseGrad, controls.pcs_mm);
    if (!primaryBlend.error) {
      const newNmas = baileyNmas(primaryBlend.gradation);
      const newControls = newNmas != null ? controlSieves(newNmas) : null;
      if (newControls) {
        newRatios = {
          new_nmas_mm: newNmas,
          new_controls: newControls,
          sample_or_primary: computeRatios(primaryBlend.gradation, newControls),
        };
        if (hasDesign && hasSample) {
          const dPrimary = finePrimaryBlend(design, controls.pcs_mm);
          if (!dPrimary.error) {
            newRatios.design = computeRatios(dPrimary.gradation, newControls);
          }
        }
      }
    } else {
      newRatios = { error: primaryBlend.error };
    }
  }

  const deltas = hasDesign && hasSample ? sieveDeltas(design, sample) : null;

  // VMA estimate from original ratios; for fine, prefer New ratios when available
  let vmaEstimate = null;
  if (hasDesign && hasSample && designRatios && sampleRatios) {
    if (mixType === "fine" && newRatios && newRatios.design && newRatios.sample_or_primary) {
      vmaEstimate = estimateVmaDeltas(
        "fine",
        newRatios.design,
        newRatios.sample_or_primary,
        designRatios.sieves.pcs.pct_passing,
        sampleRatios.sieves.pcs.pct_passing
      );
      vmaEstimate.note = "Fine-graded: VMA sensitivity uses New ratios on minus-PCS blend + Original %PCS.";
    } else {
      vmaEstimate = estimateVmaDeltas(
        mixType,
        designRatios,
        sampleRatios,
        designRatios.sieves.pcs.pct_passing,
        sampleRatios.sieves.pcs.pct_passing
      );
    }
  }

  const acvc = input.acvc != null ? parseFloat(input.acvc) : DEFAULT_ACVC;
  let acEffect = null;
  const designAc = num(input.design_ac);
  const sampleAc = num(input.sample_ac);
  if (designAc != null && sampleAc != null) {
    acEffect = estimateVaFromAc(sampleAc - designAc, acvc);
    acEffect.design_ac = designAc;
    acEffect.sample_ac = sampleAc;
  } else if (input.proposed_ac_delta != null) {
    acEffect = estimateVaFromAc(input.proposed_ac_delta, acvc);
  }

  const designVa = num(input.design_va);
  const sampleVa = num(input.sample_va);
  const designVma = num(input.design_vma);
  const sampleVma = num(input.sample_vma);

  const volumetric = {};
  if (designVa != null || sampleVa != null) {
    volumetric.va = {
      design: designVa,
      sample: sampleVa,
      delta: designVa != null && sampleVa != null ? r2(sampleVa - designVa) : null,
    };
  }
  if (designVma != null || sampleVma != null) {
    volumetric.vma = {
      design: designVma,
      sample: sampleVma,
      delta: designVma != null && sampleVma != null ? r2(sampleVma - designVma) : null,
    };
  }
  if (volumetric.va && volumetric.va.delta != null && acEffect && acEffect.approx_delta_va != null) {
    volumetric.va_residual_after_ac = r2(volumetric.va.delta - acEffect.approx_delta_va);
    volumetric.va_residual_note =
      "Sample ΔVa minus AC-only estimate. Large residual → look at gradation/packing (or Gmm/AC measurement error), not binder alone.";
  }

  // Flag biggest sieve moves on control sieves
  const controlFlags = [];
  if (deltas) {
    for (const name of ["half", "pcs", "scs", "tcs"]) {
      const mm = controls[`${name}_mm`];
      const row = deltas.find((d) => Math.abs(d.mm - mm) < 0.01);
      if (row && row.delta_sample_minus_design != null && Math.abs(row.delta_sample_minus_design) >= 1.0) {
        controlFlags.push({
          control: name.toUpperCase(),
          label: row.label,
          delta_pct: row.delta_sample_minus_design,
          meaning: row.delta_sample_minus_design > 0 ? "sample finer than design" : "sample coarser than design",
        });
      }
    }
    const dust = deltas.find((d) => Math.abs(d.mm - 0.075) < 0.001);
    if (dust && dust.delta_sample_minus_design != null && Math.abs(dust.delta_sample_minus_design) >= 0.3) {
      controlFlags.push({
        control: "#200",
        label: "#200",
        delta_pct: dust.delta_sample_minus_design,
        meaning: dust.delta_sample_minus_design > 0 ? "more dust than design" : "less dust than design",
      });
    }
  }

  return {
    status: "ok",
    nmas_mm: nmas,
    nmas_label: labelFor(nmas),
    controls: {
      half: { mm: controls.half_mm, label: labelFor(controls.half_mm) },
      pcs: { mm: controls.pcs_mm, label: labelFor(controls.pcs_mm) },
      scs: { mm: controls.scs_mm, label: labelFor(controls.scs_mm) },
      tcs: { mm: controls.tcs_mm, label: labelFor(controls.tcs_mm) },
      from_table: controls.from_table,
    },
    mix_classification: classification,
    mix_type_used: mixType,
    design_ratios: designRatios,
    sample_ratios: sampleRatios,
    new_ratios_fine_graded: newRatios,
    sieve_deltas: deltas,
    control_sieve_flags: controlFlags,
    vma_sensitivity_estimate: vmaEstimate,
    ac_void_estimate: acEffect,
    volumetric_inputs: Object.keys(volumetric).length ? volumetric : undefined,
    how_to_use: [
      "Cite these numbers in the answer; do not re-derive ratios by hand.",
      "Lead with the largest control-sieve flag and the dominant VMA lever (often FAc for dense-graded).",
      "Give bin moves that drive that lever; size conservatively on a single sample.",
      "If AC delta explains most of ΔVa, weigh the binder lever alongside gradation.",
    ],
    citations: [
      "Bailey: CA Ratio = (%Half−%PCS)/(100−%Half); FAc=%SCS/%PCS; FAf=%TCS/%SCS",
      "PCS = closest sieve to 0.22×NMAS; Half ≈ 0.5×NMAS",
      "VMA RoT CG: 4% PCS / 0.20 CA / 0.05 FAc / 0.05 FAf ≈ 1% VMA",
      "VMA RoT FG: 6% Orig PCS / 0.35 New CA / 0.05 New FAc-FAf ≈ 1% VMA",
      "ACVC 2.25; plant ±0.1% AC ≈ ∓0.22–0.25% Va",
    ],
  };
}

function num(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/%/g, ""));
  return Number.isFinite(n) ? n : null;
}

function hasGradation(p) {
  return !!(p && p.gradation_mm && typeof p.gradation_mm === "object" && Object.keys(p.gradation_mm).length);
}

function matchProduct(bin, products) {
  if (!Array.isArray(products) || !products.length) return null;
  const code = bin.material_code != null ? String(bin.material_code).replace(/\D/g, "") : "";
  const type = String(bin.agg_type || bin.type || "").toLowerCase();
  const producer = String(bin.producer || bin.loc || "").toLowerCase();
  const producerTok = producer.split(/[@,]/)[0].trim().split(/\s+/).filter(Boolean)[0] || "";

  let hits = products.slice();
  if (code) {
    hits = hits.filter((p) => String(p.material_code) === code || String(p.material_code).endsWith(code));
  }
  if (hits.length > 1 && type) {
    const tHits = hits.filter((p) => {
      const pt = String(p.agg_type || "").toLowerCase();
      return pt.includes(type) || type.includes(pt);
    });
    if (tHits.length) hits = tHits;
  }
  if (hits.length > 1 && producerTok) {
    const pHits = hits.filter((p) => String(p.producer || "").toLowerCase().includes(producerTok));
    if (pHits.length) hits = pHits;
  }
  // Prefer products that already have stockpile sieves
  if (hits.length > 1) {
    const withG = hits.filter(hasGradation);
    if (withG.length) hits = withG;
  }
  if (hits.length === 1) {
    // Exact one hit but no sieves → same material_code from another quarry (proxy)
    if (!hasGradation(hits[0]) && code) {
      const proxy = products.find(
        (p) =>
          (String(p.material_code) === code || String(p.material_code).endsWith(code)) && hasGradation(p)
      );
      if (proxy) return proxy;
    }
    return hits[0];
  }
  if (hits.length > 1) return hits.find(hasGradation) || hits[0];

  // Fallback: type-only match (prefer with gradation)
  if (type) {
    const byType = products.filter((p) => {
      const pt = String(p.agg_type || "").toLowerCase();
      return pt.includes(type) || type.includes(pt);
    });
    const withG = byType.filter(hasGradation);
    if (withG.length === 1) return withG[0];
    if (withG.length > 1 && producerTok) {
      const ph = withG.find((p) => String(p.producer || "").toLowerCase().includes(producerTok));
      if (ph) return ph;
    }
    if (withG.length) return withG[0];
  }
  // Last resort: same material code with sieves, any producer
  if (code) {
    const byCode = products.find(
      (p) =>
        (String(p.material_code) === code || String(p.material_code).endsWith(code)) && hasGradation(p)
    );
    if (byCode) return byCode;
  }
  return null;
}

/**
 * Mass-weighted combined blend gradation from stockpile % passing × bin %.
 * Each bin: { percent, material_code?, agg_type?, producer?, gradation? / gradation_mm? }
 */
export function combineBlendGradation(bins, products = []) {
  const rows = [];
  const missing = [];
  let totalPct = 0;
  for (const b of bins || []) {
    const pct = num(b.percent ?? b.pct);
    if (pct == null || pct <= 0) continue;
    let grad = normalizeGradation(b.gradation || b.gradation_mm || b.grad || {});
    let source = "inline";
    let tested = b.tested || null;
    if (!Object.keys(grad).length) {
      const prod = matchProduct(b, products);
      if (prod && prod.gradation_mm) {
        grad = normalizeGradation(prod.gradation_mm);
        source = "catalog:" + (prod.id || prod.material_code);
        tested = prod.updated || null;
      }
    }
    if (!Object.keys(grad).length) {
      missing.push({
        percent: pct,
        agg_type: b.agg_type || b.type || null,
        material_code: b.material_code || null,
        producer: b.producer || b.loc || null,
      });
      continue;
    }
    totalPct += pct;
    rows.push({
      percent: pct,
      agg_type: b.agg_type || b.type || null,
      material_code: b.material_code || null,
      producer: b.producer || b.loc || null,
      gradation: grad,
      source,
      tested,
    });
  }
  if (!rows.length) {
    return {
      error: "No bins with usable stockpile gradations.",
      missing_gradation: missing,
      hint: "Fill gradation_mm on products in aggregate_products.mjs, or pass gradation on each bin.",
    };
  }
  // renormalize if some bins missing (weight only bins we have)
  const sieveSet = new Set();
  for (const r of rows) Object.keys(r.gradation).forEach((k) => sieveSet.add(k));
  const combined = {};
  for (const k of sieveSet) {
    let acc = 0;
    for (const r of rows) {
      const p = r.gradation[k];
      if (p == null || !Number.isFinite(p)) {
        // if a stockpile lacks this sieve, treat as null contribution skip — or interpolate via passingAt
        const v = passingAt(r.gradation, parseFloat(k));
        if (v == null) continue;
        acc += (r.percent / totalPct) * v;
      } else {
        acc += (r.percent / totalPct) * p;
      }
    }
    combined[k] = r1(acc);
  }
  // Freshness: stockpiles retest ~1-2×/week at BT3; >14 days = stale, worth a fresh wash sieve.
  const STALE_DAYS = 14;
  const now = Date.now();
  const binsUsed = rows.map((r) => {
    let age_days = null, stale = null;
    if (r.tested) {
      const t = Date.parse(r.tested + (r.tested.length <= 10 ? "T00:00:00" : ""));
      if (Number.isFinite(t)) { age_days = Math.max(0, Math.floor((now - t) / 86400000)); stale = age_days > STALE_DAYS; }
    }
    return {
      percent: r.percent,
      agg_type: r.agg_type,
      material_code: r.material_code,
      producer: r.producer,
      source: r.source,
      tested: r.tested,
      age_days,
      stale,
    };
  });
  const staleOnes = binsUsed.filter((b) => b.stale);
  return {
    combined_gradation: combined,
    bins_used: binsUsed,
    percent_covered: r1(totalPct),
    missing_gradation: missing,
    stockpile_freshness: staleOnes.length
      ? `STALE stockpile sieves (> ${STALE_DAYS} days old): ` +
        staleOnes.map((b) => `${b.agg_type || b.material_code} (tested ${b.tested}, ${b.age_days}d)`).join(", ") +
        ". Blend math uses these anyway — tell the tech the prediction leans on old tests and a fresh wash sieve is worth running."
      : "All stockpile sieves current (tested within " + STALE_DAYS + " days).",
    note:
      missing.length
        ? `Combined from ${rows.length} products covering ${r1(totalPct)}% of bins; ${missing.length} bin(s) lacked stockpile sieves and were omitted (weights renormalized).`
        : `Combined blend from ${rows.length} products (${r1(totalPct)}% total).`,
  };
}

/**
 * Compare current bins vs proposed bins via stockpile-weighted blend + Bailey ratios.
 */
export function blendEstimate(input = {}, ctx = {}) {
  const products = typeof ctx.getAggregateProducts === "function" ? ctx.getAggregateProducts() : [];
  let bins = Array.isArray(input.bins) ? input.bins : null;

  // Hydrate bins from JMF aggregates if only jmf_id given
  if ((!bins || !bins.length) && input.jmf_id && ctx.getJmfRecord) {
    const rec = ctx.getJmfRecord(String(input.jmf_id).trim());
    if (rec && Array.isArray(rec.aggregates)) {
      bins = rec.aggregates.map((a) => ({
        percent: a.percent,
        material_code: a.material_code,
        agg_type: a.agg_type,
        producer: a.producer,
      }));
    }
  }
  if (!bins || !bins.length) {
    return { error: "blend_estimate needs bins[] or jmf_id with aggregates." };
  }

  const current = combineBlendGradation(bins, products);
  if (current.error) return { status: "incomplete", action: "blend_estimate", ...current };

  const proposedBins = Array.isArray(input.proposed_bins) ? input.proposed_bins : null;
  let proposed = null;
  if (proposedBins && proposedBins.length) {
    proposed = combineBlendGradation(proposedBins, products);
  }

  const nmas =
    input.nmas_mm != null && Number.isFinite(parseFloat(input.nmas_mm))
      ? parseFloat(input.nmas_mm)
      : baileyNmas(current.combined_gradation);
  if (nmas == null) return { error: "Could not determine NMAS from combined blend." };
  const controls = controlSieves(nmas);
  let mixType = String(input.mix_type || "auto").toLowerCase();
  const classification = classifyMixType(current.combined_gradation, controls);
  if (mixType === "auto" || mixType === "") {
    mixType = classification.mix_type === "sma_candidate" ? "coarse" : classification.mix_type;
    if (mixType === "unknown") mixType = "coarse";
  }

  const curRatios = computeRatios(current.combined_gradation, controls);
  let propRatios = null;
  let delta = null;
  let vmaEst = null;
  if (proposed && !proposed.error) {
    propRatios = computeRatios(proposed.combined_gradation, controls);
    delta = sieveDeltas(current.combined_gradation, proposed.combined_gradation);
    vmaEst = estimateVmaDeltas(
      mixType,
      curRatios,
      propRatios,
      curRatios.sieves.pcs.pct_passing,
      propRatios.sieves.pcs.pct_passing
    );
  }

  // Plant bin constraints (min 10% / natural sand ≤15%)
  const plantCheck = proposedBins && proposedBins.length
    ? validateBinMove(bins, proposedBins)
    : { ...validateBinPercents(bins), current: validateBinPercents(bins), proposed: null };

  const plant_rules = {
    min_bin_pct: MIN_BIN_PCT,
    max_natural_sand_pct: MAX_NATURAL_SAND_PCT,
    summary: PLANT_RULES_SUMMARY,
    check: plantCheck,
    ok: plantCheck.ok !== false,
  };

  return {
    status: proposed && proposed.error ? "partial" : (plant_rules.ok ? "ok" : "rule_violation"),
    action: "blend_estimate",
    nmas_mm: nmas,
    mix_type_used: mixType,
    mix_classification: classification,
    plant_rules,
    current: {
      ratios: curRatios,
      combined_gradation: current.combined_gradation,
      bins_used: current.bins_used,
      percent_covered: current.percent_covered,
      missing_gradation: current.missing_gradation,
      stockpile_freshness: current.stockpile_freshness,
      note: current.note,
    },
    proposed: proposed
      ? proposed.error
        ? { error: proposed.error, missing_gradation: proposed.missing_gradation }
        : {
            ratios: propRatios,
            combined_gradation: proposed.combined_gradation,
            bins_used: proposed.bins_used,
            percent_covered: proposed.percent_covered,
            missing_gradation: proposed.missing_gradation,
            note: proposed.note,
            plant_rules_ok: plant_rules.ok,
          }
      : null,
    sieve_deltas_proposed_minus_current: delta,
    vma_sensitivity_estimate: vmaEst,
    how_to_use: [
      "If plant_rules.ok is false, DO NOT recommend that proposed split — revise bins to meet min 10% and sand ≤15%.",
      "If missing_gradation is non-empty, quantitative prediction is incomplete — fill stockpile sieves.",
      "Compare current vs proposed ratios; use VMA RoT direction for the move size.",
      "Always pair with search_bailey for narrative + citations.",
    ],
  };
}

// =============================================================================
// spec_check — deterministic KYTC 402 acceptance math (Compaction Option A)
// -----------------------------------------------------------------------------
// Encodes the Lot Pay Adjustment Schedules verbatim from the Standard Specs
// (Section 402, "LOT PAY ADJUSTMENT SCHEDULE COMPACTION OPTION A", SPEC ~p183-184):
//   surface weights  AC .05 / AV .25 / VMA .25 / LaneD .30 / JointD .15
//   base/binder      AC .10 / AV .25 / VMA .25 / LaneD .40
// Gradation is not a pay item for dense mixes — it is monitored; we report drift
// vs the KM "minor change" JMF tolerances (1"–No.4 ±4, No.8–No.50 ±3, No.100 ±2,
// No.200 ±1.0). Pay value "(1)" = Department evaluates for remove/replace.
// Contract special provisions can override all of this — the caller must check SPs.
// =============================================================================

const VMA_MIN_BY_NMAS = { 37.5: 11, 25.0: 12, 19.0: 13, 12.5: 14, 9.5: 15, 4.75: 16 };
const GRAD_MONITOR_TOL = { "25.0": 4, "19.0": 4, "12.5": 4, "9.5": 4, "4.75": 4, "2.36": 3, "1.18": 3, "0.6": 3, "0.3": 3, "0.15": 2, "0.075": 1.0 };

function payAC(dev) {
  const d = Math.round(Math.abs(dev) * 10) / 10;
  if (d <= 0.5) return { pay: 1.0, band: "≤ ±0.5" };
  if (d <= 0.6) return { pay: 0.95, band: "±0.6" };
  if (d <= 0.7) return { pay: 0.9, band: "±0.7" };
  return { pay: null, band: "≥ ±0.8 — remove/replace evaluation", removeReplace: true };
}
function payVMA(vma, min) {
  const below = Math.round((min - vma) * 10) / 10;
  if (below <= 0) return { pay: 1.0, band: "≥ minimum" };
  if (below <= 0.5) return { pay: 0.95, band: "0.1–0.5 below min" };
  if (below <= 1.0) return { pay: 0.9, band: "0.6–1.0 below min" };
  return { pay: null, band: ">1.0 below min — remove/replace evaluation", removeReplace: true };
}
function payAV(av, cls) {
  const c2 = String(cls) === "2";
  if (av >= 3.2 && av <= 3.8) return { pay: 1.05, band: "3.2–3.8 (bonus)" };
  if (av >= (c2 ? 1.5 : 2.0) && av < 3.2) return { pay: r2(1.0 + 0.1 * (av - 3.0)), band: "low side, 1.00+0.1(AV−3.0)" };
  if (av > 3.8 && av <= 6.0) return { pay: r2(1.0 + 0.1 * (4.5 - av)), band: "high side, 1.00+0.1(4.5−AV)" };
  if (c2 && av > 6.0 && av <= 6.5) return { pay: 0.75, band: "6.1–6.5" };
  return { pay: null, band: (c2 ? "<1.5 or >6.5" : "<2.0 or >6.0") + " — remove/replace evaluation", removeReplace: true };
}
function payLaneDensity(d, cls) {
  const c2 = String(cls) === "2";
  if (d >= 94.0 && d <= 96.0) return { pay: 1.05, band: "94.0–96.0 (bonus)" };
  if ((d >= 92.0 && d < 94.0) || (d > 96.0 && d <= 97.0)) return { pay: 1.0, band: "92.0–93.9 / 96.1–97.0" };
  if (d >= 91.0 && d < 92.0) return { pay: 0.95, band: "91.0–91.9" };
  if ((d >= 90.0 && d < 91.0) || (d > 97.0 && d <= 97.5)) return { pay: 0.9, band: "90.0–90.9 / 97.1–97.5" };
  if (c2 && d > 97.5 && d <= 98.5) return { pay: 0.85, band: "97.6–98.5" };
  if (c2 && d >= 89.0 && d < 90.0) return { pay: 0.75, band: "89.0–89.9" };
  return { pay: null, band: (c2 ? "<89.0 or >98.5" : "<90.0 or >97.5") + " — remove/replace evaluation", removeReplace: true };
}
function payJointDensity(d) {
  if (d >= 92.0 && d <= 96.0) return { pay: 1.05, band: "92.0–96.0 (bonus)" };
  if ((d >= 90.0 && d < 92.0) || (d > 96.0 && d <= 96.5)) return { pay: 1.0, band: "90.0–91.9 / 96.1–96.5" };
  if (d >= 89.0 && d < 90.0) return { pay: 0.95, band: "89.0–89.9" };
  if ((d >= 88.0 && d < 89.0) || (d > 96.5 && d <= 97.0)) return { pay: 0.9, band: "88.0–88.9 / 96.6–97.0" };
  return { pay: 0.75, band: "<88.0 or >97.0" };
}

export function specCheck(input = {}) {
  const cls = String(input.aadtt_class || "").includes("2") ? "2" : "3or4";
  const mixClass = /base|binder/i.test(String(input.mixture_class || "")) ? "base" : "surface";
  const designGrad = normalizeGradation(input.design_gradation || {});
  const designAc = num(input.design_ac);
  const props = [];
  const flags = [];
  let removeReplace = false;

  function push(name, weight, sample, detail, target) {
    props.push({ property: name, weight_pct: weight, sample, target: target ?? null, ...detail });
    if (detail.removeReplace) { removeReplace = true; flags.push(`${name} in remove/replace band (${detail.band}).`); }
  }

  const weights = mixClass === "surface"
    ? { AC: 5, AV: 25, VMA: 25, "Lane density": 30, "Joint density": 15 }
    : { AC: 10, AV: 25, VMA: 25, "Lane density": 40 };

  if (num(input.sample_ac) != null && designAc != null) {
    const dev = r2(num(input.sample_ac) - designAc);
    push("AC", weights.AC, num(input.sample_ac), { deviation_from_jmf: dev, ...payAC(dev) }, designAc);
  }
  if (num(input.sample_va) != null) {
    push("AV", weights.AV, num(input.sample_va), payAV(num(input.sample_va), cls), "3.2–3.8 for 1.05");
  }
  let vmaMin = num(input.vma_min);
  if (vmaMin == null) {
    const nmas = input.nmas_mm != null ? parseFloat(input.nmas_mm) : baileyNmas(designGrad);
    if (nmas != null && VMA_MIN_BY_NMAS[nmas] != null) vmaMin = VMA_MIN_BY_NMAS[nmas];
  }
  if (num(input.sample_vma) != null && vmaMin != null) {
    push("VMA", weights.VMA, num(input.sample_vma), payVMA(num(input.sample_vma), vmaMin), `min ${vmaMin}`);
  }
  if (num(input.lane_density) != null) {
    push("Lane density", weights["Lane density"], num(input.lane_density), payLaneDensity(num(input.lane_density), cls), "94.0–96.0 for 1.05");
  }
  if (mixClass === "surface" && num(input.joint_density) != null) {
    push("Joint density", weights["Joint density"], num(input.joint_density), payJointDensity(num(input.joint_density)), "92.0–96.0 for 1.05");
  }

  // Gradation drift vs KM minor-change tolerances (monitor, not a pay item)
  const gradation_drift = [];
  const sampleGrad = normalizeGradation(input.sample_gradation || {});
  for (const [mm, tol] of Object.entries(GRAD_MONITOR_TOL)) {
    if (sampleGrad[mm] == null || designGrad[mm] == null) continue;
    const dev = r1(sampleGrad[mm] - designGrad[mm]);
    const out = Math.abs(dev) > tol;
    gradation_drift.push({ sieve_mm: mm, sieve: SIEVE_MM_TO_LABEL[mm] || mm, jmf: designGrad[mm], sample: sampleGrad[mm], deviation: dev, tolerance: tol, within: !out });
    if (out) flags.push(`${SIEVE_MM_TO_LABEL[mm] || mm} off JMF by ${dev > 0 ? "+" : ""}${dev} (monitor tolerance ±${tol}).`);
  }

  // Composite pay factor over the properties provided (weights renormalized)
  const usable = props.filter((p) => p.pay != null);
  let composite = null, lotAdj = null;
  if (usable.length) {
    const wSum = usable.reduce((t, p) => t + p.weight_pct, 0);
    const raw = usable.reduce((t, p) => t + p.pay * (p.weight_pct / wSum), 0);
    composite = Math.round(raw * 10000) / 10000;
    const tons = num(input.quantity_tons);
    if (tons != null && !removeReplace && usable.length === Object.keys(weights).length) {
      lotAdj = Math.round(50 * tons * (raw - 1.0) * 100) / 100; // dollars from the unrounded factor
    }
  }

  return {
    status: "ok",
    action: "spec_check",
    schedule: `KYTC 402 Lot Pay Adjustment, Compaction Option A — ${mixClass} mixtures, AADTT Class ${cls === "2" ? "2" : "3 or 4"}`,
    weights_pct: weights,
    properties: props,
    gradation_drift,
    composite_pay_factor: composite,
    composite_note: usable.length && usable.length < Object.keys(weights).length
      ? `Computed from ${usable.length}/${Object.keys(weights).length} properties (weights renormalized) — provide the rest for the full lot factor.`
      : null,
    lot_pay_adjustment_usd: lotAdj,
    remove_replace_risk: removeReplace,
    flags,
    caveats: [
      "Lot = 4,000 tons, sublot = 1,000 tons; acceptance uses lot averages, not one sublot.",
      "Gradation drift shown vs KM minor-change JMF tolerances — monitored, not a pay item for dense mixes.",
      "Contract special provisions can override this schedule — check search_contracts for this job.",
      "Advisory math — verify against the AMAW / controlling documents.",
    ],
  };
}

// =============================================================================
// jmf_drift — approved design curve vs what the SAME bin percentages actually
// produce on today's stockpiles, plus a suggested bin move that pulls the
// current blend back toward the design target.
// -----------------------------------------------------------------------------
// Why it exists: the design was built on piles as they tested at design time.
// Piles move. Running the design's bin % today can land off the approved curve
// through no fault of the plant. This makes that drift visible and correctable.
// Error is measured in FRACTIONS OF THE ALLOWABLE tolerance per sieve, so a
// 1.0 pt miss on #200 (tol ±1.0) counts as heavily as 4 pts on 3/8" (tol ±4).
// =============================================================================
function driftError(grad, target) {
  let sum = 0, n = 0, worst = 0;
  for (const [mm, tol] of Object.entries(GRAD_MONITOR_TOL)) {
    if (grad[mm] == null || target[mm] == null) continue;
    const norm = Math.abs(grad[mm] - target[mm]) / tol;
    sum += norm * norm;
    worst = Math.max(worst, norm);
    n++;
  }
  return n ? { rms: Math.sqrt(sum / n), worst } : { rms: 0, worst: 0 };
}

/** Absolute curve mismatch in % passing (not /tolerance) — #200 ±1 doesn't dominate the score. */
function curveAbsError(grad, target) {
  let sum = 0, n = 0, worst = 0;
  for (const mm of Object.keys(GRAD_MONITOR_TOL)) {
    if (grad[mm] == null || target[mm] == null) continue;
    const d = Math.abs(grad[mm] - target[mm]);
    sum += d * d;
    worst = Math.max(worst, d);
    n++;
  }
  return n ? { rms: Math.sqrt(sum / n), worst } : { rms: 0, worst: 0 };
}

/**
 * Hill-climb bins toward design Va + JMF curve on today's stockpiles.
 * Primary: hypo Va → design Va (usually 3.5). Secondary: absolute curve match.
 * KM tolerances are reported as flags — they do NOT own the optimizer.
 */
function suggestBinsToMatch(bins, products, target, opts = {}) {
  const maxTotalMove = opts.max_total_move != null ? opts.max_total_move : 30;
  const designVa = opts.design_va != null ? Number(opts.design_va) : 3.5;
  const acvc = opts.acvc != null ? parseFloat(opts.acvc) : DEFAULT_ACVC;
  const baseline = bins.map((b) => ({ ...b, percent: Math.round(Number(b.percent ?? b.pct) || 0) }));
  const isRap = (b) => /\brap\b|recycl/i.test(String(b.agg_type || b.type || "")) || String(b.material_code ?? "") === "24033";
  const allowRap = opts.allow_rap_change === true;
  const locked = (i) => !allowRap && isRap(baseline[i]);

  // The designation switches on the A-mix polish-resistant floor. This is a HARD
  // constraint, not another term in the score: a split that raises hypo Va by
  // trading dolomite for limestone is out of spec no matter how good the Va is.
  // Real miss — a 0.38A recovery landed at 50% PRC against a 70% minimum.
  const ruleOpts = { mix_designation: opts.mix_designation || null };
  const evalBins = (cand) => {
    const blend = combineBlendGradation(cand, products);
    if (blend.error) return null;
    const rules = validateBinPercents(cand, baseline, ruleOpts);
    if (!rules.ok) return null;
    const errTol = driftError(blend.combined_gradation, target);
    const errAbs = curveAbsError(blend.combined_gradation, target);
    const voids = voidsFromGradationDelta(target, blend.combined_gradation, designVa);
    const predVa = voids.ok && voids.predicted_va != null ? voids.predicted_va : null;
    const vaErr = predVa != null ? Math.abs(predVa - designVa) : 50;
    // Va first when off design; absolute sieve RMS second (not tol-fraction)
    const score = vaErr * 14 + errAbs.rms * 0.12;
    return {
      blend,
      err: errTol,
      errAbs,
      predVa,
      vaErr,
      score,
      voids,
    };
  };

  const start = evalBins(baseline);
  if (!start) return { ok: false, reason: "Baseline blend can't be computed from current stockpile gradations." };

  let best = baseline.map((b) => ({ ...b }));
  let bestEval = start;
  let moved = 0;
  // Larger steps when Va is crushed — 1-pt polish is useless for 2.19 → 3.5
  const stepSizes = start.vaErr >= 1.0 ? [1, 2] : start.vaErr >= 0.5 ? [1, 2] : [1];
  const maxIter = start.vaErr >= 1.0 ? 50 : 40;

  for (let iter = 0; iter < maxIter && moved < maxTotalMove; iter++) {
    let found = null;
    for (const step of stepSizes) {
      for (let i = 0; i < best.length; i++) {
        for (let j = 0; j < best.length; j++) {
          if (i === j) continue;
          if (locked(i) || locked(j)) continue;
          if (best[i].percent < step) continue;
          const cand = best.map((b) => ({ ...b }));
          cand[i].percent -= step;
          cand[j].percent += step;
          // plant floor: no 1–9% active bins (0% OK)
          if (cand[i].percent > 0 && cand[i].percent < MIN_BIN_PCT) {
            const base = baseline[i].percent;
            if (!(base > 0 && base < MIN_BIN_PCT && cand[i].percent >= base)) continue;
          }
          if (isNaturalSand(cand[j]) && cand[j].percent > MAX_NATURAL_SAND_PCT) continue;
          const got = evalBins(cand);
          if (!got) continue;
          // Never take a step that worsens Va when we're already off design
          if (start.vaErr >= 0.35 && got.vaErr > bestEval.vaErr + 0.02) continue;
          if (got.score < bestEval.score - 1e-9 && (!found || got.score < found.score)) {
            found = { cand, score: got.score, eval: got, step };
          }
        }
      }
    }
    if (!found) break;
    best = found.cand;
    bestEval = found.eval;
    moved += found.step || 1;
  }

  const finalEval = bestEval;
  const changes = best
    .map((b, i) => ({
      agg_type: b.agg_type || b.type || null,
      producer: b.producer || null,
      material_code: b.material_code ?? null,
      from: baseline[i].percent,
      to: b.percent,
      delta: b.percent - baseline[i].percent,
    }))
    .filter((c) => c.delta !== 0);

  // Optional AC stack when packing alone still leaves a big Va hole (low voids)
  let proposedAcDelta = null;
  let predVaWithAc = finalEval.predVa;
  if (
    finalEval.predVa != null &&
    finalEval.predVa < designVa - 0.4
  ) {
    // ACVC: need roughly +(design−pred) Va → ΔAC ≈ −ΔVa / 2.25
    const need = designVa - finalEval.predVa;
    let dAc = r2(-need / acvc);
    // Cap field AC moves; larger needs lab judgment
    if (dAc < -0.5) dAc = -0.5;
    if (dAc > -0.1) dAc = -0.1;
    proposedAcDelta = dAc;
    predVaWithAc = r2(finalEval.predVa + estimateVaFromAc(dAc, acvc).approx_delta_va);
  } else if (
    finalEval.predVa != null &&
    finalEval.predVa > designVa + 0.4
  ) {
    const need = finalEval.predVa - designVa;
    let dAc = r2(need / acvc);
    if (dAc > 0.5) dAc = 0.5;
    if (dAc < 0.1) dAc = 0.1;
    proposedAcDelta = dAc;
    predVaWithAc = r2(finalEval.predVa + estimateVaFromAc(dAc, acvc).approx_delta_va);
  }

  const rapChanged = changes.some((c) => /\brap\b|recycl/i.test(String(c.agg_type || "")));
  const rapAfter = best.reduce((t, b, i) => t + (isRap(baseline[i]) ? b.percent : 0), 0);
  const rapBefore = baseline.reduce((t, b) => t + (isRap(b) ? b.percent : 0), 0);
  const stillOut = [], fixed = [];
  for (const [mm, tol] of Object.entries(GRAD_MONITOR_TOL)) {
    if (target[mm] == null) continue;
    const b4 = start.blend.combined_gradation[mm], af = finalEval.blend.combined_gradation[mm];
    if (b4 == null || af == null) continue;
    const wasOut = Math.abs(b4 - target[mm]) > tol;
    const nowOut = Math.abs(af - target[mm]) > tol;
    const label = SIEVE_MM_TO_LABEL[mm] || mm;
    if (wasOut && nowOut) stillOut.push(label);
    else if (wasOut && !nowOut) fixed.push(label);
  }

  const vaImproved =
    start.predVa != null &&
    finalEval.predVa != null &&
    Math.abs(finalEval.predVa - designVa) < Math.abs(start.predVa - designVa) - 0.05;

  // Tiny moves that don't help Va when Va is the problem → treat as no useful change
  const useless =
    start.vaErr >= 0.5 &&
    changes.length > 0 &&
    !vaImproved &&
    Math.abs((finalEval.predVa || 0) - (start.predVa || 0)) < 0.08;

  let verdict;
  if (useless) {
    verdict =
      `Could not find a plant-legal re-proportion that meaningfully raises hypo Va toward ${designVa}% ` +
      `(stays ~${finalEval.predVa}%). Piles may have shifted (dust/size) beyond bin tweaks — try Mix change → Suggest moves with a plant sample, or product/JMF path.`;
  } else if (vaImproved && stillOut.length) {
    verdict =
      `Recovery prioritizes design Va (~${finalEval.predVa}% packing` +
      (proposedAcDelta != null ? `, ~${predVaWithAc}% with AC ${proposedAcDelta > 0 ? "+" : ""}${proposedAcDelta}` : "") +
      ` vs target ${designVa}%). ${stillOut.join(", ")} may still sit outside minor-change band — often dust/product in the pile; bins may not fully fix that sieve.`;
  } else if (stillOut.length && !vaImproved) {
    verdict =
      `${stillOut.join(", ")} still outside minor-change band after re-proportion — material moved (often dust). ` +
      (finalEval.predVa != null
        ? `Hypo Va ~${finalEval.predVa}% (target ${designVa}%). `
        : "") +
      `Options: wash/different product, revised JMF, or manage with plant samples.`;
  } else if (fixed.length) {
    verdict = `This move brings ${fixed.join(", ")} back inside tolerance` +
      (finalEval.predVa != null ? ` and hypo Va ~${finalEval.predVa}% (target ${designVa}%).` : ".");
  } else if (vaImproved) {
    verdict =
      `Recovery moves hypo Va toward design: ~${start.predVa}% → ~${finalEval.predVa}%` +
      (proposedAcDelta != null ? ` (with AC ${proposedAcDelta > 0 ? "+" : ""}${proposedAcDelta} → ~${predVaWithAc}%)` : "") +
      ` · target ${designVa}%.`;
  } else {
    verdict = "Closest plant-legal match on today's piles under bin rules.";
  }

  return {
    ok: true,
    changed: useless ? false : changes.length > 0,
    action_needed: useless ? false : changes.length > 0,
    points_moved: useless ? 0 : moved,
    hit_move_cap: moved >= maxTotalMove,
    rap_locked: !allowRap,
    objective: "va_first_then_curve",
    brings_in_tolerance: fixed,
    still_out_after: stillOut,
    design_va_target: designVa,
    hypo_va_before: start.predVa,
    hypo_va_after: useless ? start.predVa : finalEval.predVa,
    proposed_ac_delta: useless ? null : proposedAcDelta,
    hypo_va_with_ac: useless ? null : proposedAcDelta != null ? predVaWithAc : null,
    verdict,
    notes: [
      "Optimizer: design Va first, absolute JMF curve second. KM tolerances are flags, not the score.",
      rapChanged
        ? `This move changes RAP (${rapBefore}% → ${rapAfter}%) — plant meters RAP binder; re-check AC.`
        : null,
      rapAfter > 20 && rapBefore <= 20
        ? `⚠ RAP would cross 20% (to ${rapAfter}%). May need softer virgin grade / JMF revision.`
        : null,
      proposedAcDelta != null && !useless
        ? `Suggested AC change ${proposedAcDelta > 0 ? "+" : ""}${proposedAcDelta} pt stacked on recovery bins (ACVC ${acvc}) — lab judgment on large AC moves.`
        : null,
      stillOut.length
        ? `${stillOut.join(", ")} outside minor-change band may need product/wash/revised JMF even if Va improves.`
        : null,
      moved >= maxTotalMove ? `Hit the ${maxTotalMove}-point movement guard.` : null,
      changes.length === 0 || useless
        ? "No useful bin path found under plant rules for Va + curve — hold design bins or use a plant sample with Suggest moves."
        : null,
    ].filter(Boolean),
    changes: useless ? [] : changes,
    suggested_bins: (useless ? baseline : best).map((b) => ({
      agg_type: b.agg_type || b.type || null,
      producer: b.producer || null,
      material_code: b.material_code ?? null,
      percent: b.percent,
    })),
    before: {
      rms_of_tolerance: r2(start.err.rms),
      worst_sieve_fraction: r2(start.err.worst),
      curve_rms_abs: r2(start.errAbs.rms),
      hypo_va: start.predVa,
    },
    after: {
      rms_of_tolerance: r2(finalEval.err.rms),
      worst_sieve_fraction: r2(finalEval.err.worst),
      curve_rms_abs: r2(finalEval.errAbs.rms),
      hypo_va: finalEval.predVa,
    },
    suggested_gradation: (useless ? start : finalEval).blend.combined_gradation,
    rap_before_pct: rapBefore,
    rap_after_pct: useless ? rapBefore : rapAfter,
  };
}

/**
 * Bailey RoT: approximate ΔVa (≈ ΔVMA) when blend gradation moves from base → other.
 * Anchor: base gradation is the approved JMF curve that landed design Va (usually 3.5).
 */
function voidsFromGradationDelta(baseGrad, otherGrad, designVa, mixTypeHint) {
  if (!baseGrad || !otherGrad || designVa == null) {
    return { ok: false, reason: "Need design gradation, comparison gradation, and design Va." };
  }
  const nmas = baileyNmas(baseGrad) || baileyNmas(otherGrad);
  if (nmas == null) return { ok: false, reason: "Could not determine NMAS." };
  const controls = controlSieves(nmas);
  const classification = classifyMixType(baseGrad, controls);
  let mixType =
    mixTypeHint ||
    (classification.mix_type === "fine"
      ? "fine"
      : classification.mix_type === "sma" || classification.mix_type === "sma_candidate"
        ? "sma"
        : "coarse");
  if (mixType === "unknown") mixType = "coarse";
  const cr = computeRatios(baseGrad, controls);
  const pr = computeRatios(otherGrad, controls);
  if (cr.error || pr.error) return { ok: false, reason: "Could not compute Bailey ratios." };
  const fromRoT = estimateVmaDeltas(
    mixType,
    cr,
    pr,
    cr.sieves && cr.sieves.pcs ? cr.sieves.pcs.pct_passing : null,
    pr.sieves && pr.sieves.pcs ? pr.sieves.pcs.pct_passing : null
  );
  let dVma = fromRoT.total_approx_vma;
  // Dominant lever if components cancel
  const comps = fromRoT.components || [];
  let dominant = null;
  for (const c of comps) {
    if (dominant == null || Math.abs(c.approx_delta_vma || 0) > Math.abs(dominant.approx_delta_vma || 0)) {
      dominant = c;
    }
  }
  if ((dVma == null || Math.abs(dVma) < 0.08) && dominant && Math.abs(dominant.approx_delta_vma || 0) >= 0.08) {
    dVma = dominant.approx_delta_vma;
  }
  // PCS force when moved hard
  const pcs0 = cr.sieves && cr.sieves.pcs ? cr.sieves.pcs.pct_passing : null;
  const pcs1 = pr.sieves && pr.sieves.pcs ? pr.sieves.pcs.pct_passing : null;
  if (pcs0 != null && pcs1 != null && Math.abs(pcs1 - pcs0) >= 2) {
    const sens = mixType === "fine" ? 6 : mixType === "sma" ? 2 : 4;
    const sign = mixType === "fine" ? 1 : -1;
    const dPcs = r2(sign * ((pcs1 - pcs0) / sens));
    if (dVma == null || Math.abs(dPcs) > Math.abs(dVma)) dVma = dPcs;
  }
  const predictedVa = dVma != null ? r2(designVa + dVma) : null;
  return {
    ok: predictedVa != null,
    design_va_anchor: designVa,
    approx_delta_vma: dVma,
    approx_delta_va: dVma, // voids follow VMA at constant binder volume (RoT)
    predicted_va: predictedVa,
    mix_type_used: mixType,
    nmas_mm: nmas,
    dominant_lever: dominant ? dominant.lever : null,
    ratios_base: cr,
    ratios_other: pr,
    vma_components: fromRoT.components,
    method:
      "Anchor = approved JMF curve at design Va (usually 3.5%). ΔVMA from Bailey ratio RoTs " +
      "(design curve → this blend). Hypothetical Va ≈ design Va + ΔVMA. Advisory — not a lab result.",
  };
}

export function jmfDrift(input = {}, ctx = {}) {
  const rec = input.jmf_id && ctx.getJmfRecord ? ctx.getJmfRecord(String(input.jmf_id).trim()) : null;
  if (!rec) return { error: `No mix design matched "${input.jmf_id || ""}".` };
  const target = normalizeGradation(rec.jmf_gradation_mm || {});
  if (!Object.keys(target).length) return { error: "That design has no JMF gradation on file." };
  const products = typeof ctx.getAggregateProducts === "function" ? ctx.getAggregateProducts() : [];
  const bins = (rec.aggregates || []).map((a) => ({
    percent: a.percent, material_code: a.material_code, agg_type: a.agg_type, producer: a.producer,
  }));
  if (!bins.length) return { error: "That design has no aggregate bins on file." };

  const now = combineBlendGradation(bins, products);
  if (now.error) {
    return {
      status: "incomplete",
      action: "jmf_drift",
      mix_name: String(rec.source_file || "").replace(/\.xlsm?$/i, ""),
      error: now.error,
      missing_gradation: now.missing_gradation,
      note: "No current stockpile gradations for this design's bins — upload wash sieves for these products first.",
    };
  }

  // per-sieve comparison, coarse → fine
  const rows = Object.entries(GRAD_MONITOR_TOL)
    .map(([mm, tol]) => ({ mm: parseFloat(mm), tol, jmf: target[mm], now: now.combined_gradation[mm] }))
    .filter((r) => r.jmf != null && r.now != null)
    .sort((a, b) => b.mm - a.mm)
    .map((r) => {
      const dev = r1(r.now - r.jmf);
      return {
        sieve: SIEVE_MM_TO_LABEL[String(r.mm)] || SIEVE_MM_TO_LABEL[r.mm.toFixed(r.mm < 1 ? 3 : 1)] || String(r.mm),
        sieve_mm: r.mm, jmf: r.jmf, now: r.now, deviation: dev, tolerance: r.tol,
        within: Math.abs(dev) <= r.tol,
        fraction_of_tolerance: r2(Math.abs(dev) / r.tol),
      };
    });
  // Attach the HYPO NEW JMF — what the curve actually becomes if the tech adopts
  // the proposed bins. A tech deciding whether to run this needs the resulting
  // gradation, not a tolerance column they've already been told doesn't drive
  // the recovery (Jake: optimise for design Va, tolerances are flags).
  const outs = rows.filter((r) => !r.within);
  const err = driftError(now.combined_gradation, target);

  // Goal: original JMF = design Va (almost always 3.5). Today's piles at design bins → hypo Va.
  const designVa =
    num(input.design_va) ?? num((rec.design_volumetrics || {}).air_voids_pct) ?? 3.5;
  const voidsToday = voidsFromGradationDelta(target, now.combined_gradation, designVa);
  const errNow =
    voidsToday.ok && voidsToday.predicted_va != null
      ? Math.abs(voidsToday.predicted_va - designVa)
      : null;

  // Already good? Don't invent a 9-pt RAP shuffle "to tighten the curve."
  const allInTol = outs.length === 0;
  const vaNearDesign = errNow != null && errNow <= 0.25;
  const alreadyGood = allInTol && (vaNearDesign || errNow == null);

  // RAP locked unless explicitly allowed — design RAP% is part of the JMF fingerprint
  const allowRap = input.allow_rap_change === true;
  let suggestion;
  if (alreadyGood) {
    suggestion = {
      ok: true,
      changed: false,
      action_needed: false,
      points_moved: 0,
      rap_locked: !allowRap,
      verdict:
        "No recovery needed — hold design bin percentages. Today's piles already reproduce the JMF within every minor-change tolerance" +
        (vaNearDesign && voidsToday.predicted_va != null
          ? ` and hypo Va (~${voidsToday.predicted_va}%) is near design ${designVa}%.`
          : "."),
      notes: [
        "Cosmetic curve-tightening is not worth a plant change when everything is already in band.",
        "Do not move RAP just to shave off-target score — RAP changes metered binder.",
        "Act only if a plant sample goes out of spec on Va/AC/VMA, or a sieve actually leaves tolerance.",
      ],
      changes: [],
      suggested_bins: bins.map((b) => ({
        agg_type: b.agg_type,
        producer: b.producer,
        material_code: b.material_code,
        percent: b.percent,
      })),
      suggested_gradation: now.combined_gradation,
      before: { rms_of_tolerance: r2(err.rms), worst_sieve_fraction: r2(err.worst) },
      after: { rms_of_tolerance: r2(err.rms), worst_sieve_fraction: r2(err.worst) },
      rap_before_pct: bins.reduce((t, b) => t + (isRapBin(b) ? Number(b.percent) || 0 : 0), 0),
      rap_after_pct: bins.reduce((t, b) => t + (isRapBin(b) ? Number(b.percent) || 0 : 0), 0),
      brings_in_tolerance: [],
      still_out_after: [],
    };
  } else {
    suggestion = suggestBinsToMatch(bins, products, target, {
      max_total_move: input.max_total_move != null ? input.max_total_move : 30,
      allow_rap_change: allowRap,
      design_va: designVa,
      mix_designation: designationOf(rec),
    });
  }

  if (suggestion && suggestion.changed && suggestion.suggested_gradation) {
    const hg = suggestion.suggested_gradation;
    // Keys are mm strings but not in one canonical form ("25.0" vs "25"), so match
    // numerically. String lookup alone silently dropped every whole-mm sieve.
    const hgByMm = new Map();
    for (const [k, v] of Object.entries(hg)) {
      const n = Number(k);
      if (Number.isFinite(n)) hgByMm.set(n, v);
    }
    for (const row of rows) {
      const v = hgByMm.has(Number(row.sieve_mm)) ? hgByMm.get(Number(row.sieve_mm)) : null;
      if (v != null && Number.isFinite(Number(v))) {
        row.hypo_new_jmf = r2(Number(v));
        row.hypo_vs_design = r2(Number(v) - Number(row.jmf));
      }
    }
  }

  let voidsRecovered = null;
  if (suggestion && suggestion.ok && suggestion.changed && suggestion.suggested_gradation) {
    voidsRecovered = voidsFromGradationDelta(target, suggestion.suggested_gradation, designVa);
  }
  let errRec =
    voidsRecovered && voidsRecovered.ok && voidsRecovered.predicted_va != null
      ? Math.abs(voidsRecovered.predicted_va - designVa)
      : null;

  // Reject recovery that worsens hypo Va vs holding design bins (curve cosmetics over voids)
  if (suggestion && suggestion.changed && errNow != null && errRec != null && errRec > errNow + 0.05) {
    suggestion = {
      ok: true,
      changed: false,
      action_needed: false,
      rejected_recovery: true,
      points_moved: 0,
      rap_locked: !allowRap,
      verdict:
        `A curve-tightening bin move was computed but hypo Va would move farther from design (${voidsRecovered.predicted_va}% vs ${voidsToday.predicted_va}% at design bins). Hold design bins.`,
      notes: [
        "Matching sieves slightly tighter is not worth a lower (or higher) predicted Va vs the JMF anchor.",
        "If plant samples are out on voids, use Mix change → Suggest moves (Va-driven), not cosmetic JMF curve polish.",
      ],
      changes: [],
      suggested_bins: bins.map((b) => ({
        agg_type: b.agg_type,
        producer: b.producer,
        material_code: b.material_code,
        percent: b.percent,
      })),
      suggested_gradation: now.combined_gradation,
      before: { rms_of_tolerance: r2(err.rms), worst_sieve_fraction: r2(err.worst) },
      after: { rms_of_tolerance: r2(err.rms), worst_sieve_fraction: r2(err.worst) },
      rap_before_pct: suggestion.rap_before_pct,
      rap_after_pct: suggestion.rap_before_pct,
      brings_in_tolerance: [],
      still_out_after: outs.map((r) => r.sieve),
    };
    voidsRecovered = null;
    errRec = errNow;
  }

  // Also reject "tighten match" when already all in tolerance (even if va slightly off — unless voids improve a lot)
  if (
    suggestion &&
    suggestion.changed &&
    allInTol &&
    !(errRec != null && errNow != null && errRec < errNow - 0.1)
  ) {
    suggestion = {
      ok: true,
      changed: false,
      action_needed: false,
      points_moved: 0,
      rap_locked: !allowRap,
      verdict:
        "No recovery recommended — every sieve is already within minor-change tolerance at design bins. Hold the design split.",
      notes: [
        "Sieves marked 'close' are still legal. Do not re-proportion (or move RAP) for cosmetics.",
        voidsToday.predicted_va != null
          ? `Hypo Va at design bins ≈ ${voidsToday.predicted_va}% (target ${designVa}%). If plant samples disagree, chase the sample with Suggest moves — not a curve polish.`
          : null,
      ].filter(Boolean),
      changes: [],
      suggested_bins: bins.map((b) => ({
        agg_type: b.agg_type,
        producer: b.producer,
        material_code: b.material_code,
        percent: b.percent,
      })),
      suggested_gradation: now.combined_gradation,
      before: { rms_of_tolerance: r2(err.rms), worst_sieve_fraction: r2(err.worst) },
      after: { rms_of_tolerance: r2(err.rms), worst_sieve_fraction: r2(err.worst) },
      rap_before_pct: bins.reduce((t, b) => t + (isRapBin(b) ? Number(b.percent) || 0 : 0), 0),
      rap_after_pct: bins.reduce((t, b) => t + (isRapBin(b) ? Number(b.percent) || 0 : 0), 0),
      brings_in_tolerance: [],
      still_out_after: [],
    };
    voidsRecovered = null;
  }

  const jmfConfBase = {
    percent_covered: Number(now.percent_covered) || 0,
    missing_count: (now.missing_gradation || []).length,
    stockpile_freshness: now.stockpile_freshness || "",
    packing_available: !now.error,
  };
  const confToday = predictionConfidence({
    ...jmfConfBase,
    packing_delta_va: voidsToday.approx_delta_va,
    ac_delta: 0,
    context: "jmf_drift_today",
  });
  const confRec =
    voidsRecovered && voidsRecovered.ok
      ? predictionConfidence({
          ...jmfConfBase,
          packing_delta_va: voidsRecovered.approx_delta_va,
          ac_delta: suggestion && suggestion.proposed_ac_delta,
          context: "jmf_drift_recovery",
        })
      : null;

  const voids_estimate = {
    design_va_target: designVa,
    goal:
      "Only re-proportion when today's piles at design bins leave the JMF curve (or hypo Va is off design). " +
      `JMF designed for ~${designVa}% Va.`,
    confidence: confToday,
    at_design_bins_today: voidsToday.ok
      ? {
          predicted_va: voidsToday.predicted_va,
          approx_delta_va_vs_jmf: voidsToday.approx_delta_va,
          dominant_lever: voidsToday.dominant_lever,
          mix_type_used: voidsToday.mix_type_used,
          confidence: confToday,
          interpretation:
            voidsToday.predicted_va == null
              ? null
              : Math.abs(voidsToday.predicted_va - designVa) < 0.15
                ? `Today's piles at design bins still look near design voids (~${designVa}%).`
                : voidsToday.predicted_va < designVa
                  ? `At design bin %, today's piles look ~${r2(designVa - voidsToday.predicted_va)} pts LOW on Va vs the JMF (~${voidsToday.predicted_va}% vs ${designVa}%).`
                  : `At design bin %, today's piles look ~${r2(voidsToday.predicted_va - designVa)} pts HIGH on Va vs the JMF (~${voidsToday.predicted_va}% vs ${designVa}%).`,
        }
      : { error: voidsToday.reason || "Could not estimate." },
    after_recovery_bins:
      voidsRecovered && voidsRecovered.ok && suggestion && suggestion.changed
        ? {
            predicted_va: voidsRecovered.predicted_va,
            approx_delta_va_vs_jmf: voidsRecovered.approx_delta_va,
            dominant_lever: voidsRecovered.dominant_lever,
            confidence: confRec,
            closer_to_design_va:
              errNow != null && errRec != null ? errRec < errNow - 0.02 : null,
            interpretation:
              voidsRecovered.predicted_va == null
                ? null
                : `After the suggested bin recovery, hypo Va ≈ ${voidsRecovered.predicted_va}% (target ${designVa}%).`,
          }
        : {
            note:
              suggestion && suggestion.changed === false
                ? "No bin change recommended — hypo Va is for design bins on today's piles only."
                : null,
          },
    method: voidsToday.method,
    caveat:
      "Hypothetical Va from Bailey packing RoT only (constant binder). RAP% / AC shifts from re-proportioning are separate. Confirm on a plant sample.",
  };

  if (suggestion && typeof suggestion === "object") {
    suggestion.voids_at_design_bins_today = voids_estimate.at_design_bins_today;
    suggestion.voids_after_recovery = voids_estimate.after_recovery_bins;
    suggestion.design_va_target = designVa;
    suggestion.action_needed = suggestion.changed === true;
  }

  // Report the polish-resistant position explicitly. The optimizer already refuses
  // to break it, but a tech looking at a recovery needs to SEE the number — on an
  // A mix sitting exactly at 70.0% there is zero headroom, so "why can't it move
  // more dolomite out" has a visible answer instead of a silent constraint.
  const _designation = designationOf(rec);
  const _prcApplies = isAMix(_designation);
  const _prcDesign = Math.round(prcPercent(bins) * 10) / 10;
  const _prcAfter = suggestion && suggestion.changed && Array.isArray(suggestion.suggested_bins)
    ? Math.round(prcPercent(suggestion.suggested_bins) * 10) / 10
    : null;
  return {
    status: "ok",
    action: "jmf_drift",
    mix_name: String(rec.source_file || "").replace(/\.xlsm?$/i, ""),
    polish_resistant: {
      applies: _prcApplies,
      minimum_pct: MIN_PRC_PCT,
      counts: "dolomite + natural sand ONLY — limestone, siltstone and RAP do not count",
      at_design_bins_pct: _prcDesign,
      after_recovery_pct: _prcAfter,
      headroom_pts: _prcApplies ? Math.round((_prcDesign - MIN_PRC_PCT) * 10) / 10 : null,
      note: !_prcApplies
        ? `Not an "A" mix — the ${MIN_PRC_PCT}% polish-resistant floor does not apply.`
        : _prcDesign <= MIN_PRC_PCT + 0.05
          ? `"A" mix at ${_prcDesign}% polish-resistant with a ${MIN_PRC_PCT}% floor — NO headroom. Dolomite and natural sand cannot be cut at all; recovery has to come from the limestone/RAP side or from AC.`
          : `"A" mix: ${_prcDesign}% polish-resistant against a ${MIN_PRC_PCT}% floor (${Math.round((_prcDesign - MIN_PRC_PCT) * 10) / 10} pts of headroom).`,
    },
    goal:
      "Recover the original JMF only when today's piles at design bins are off the approved curve or design Va. " +
      "If already in band near " +
      designVa +
      "% Va — hold design bins (do not polish).",
    design_va_target: designVa,
    action_needed: !!(suggestion && suggestion.changed),
    design_bins: bins.map((b) => ({ agg_type: b.agg_type, producer: b.producer, material_code: b.material_code, percent: b.percent })),
    comparison: rows,
    out_of_tolerance: outs.map((r) => r.sieve),
    drift_summary: outs.length
      ? `${outs.length} sieve(s) outside the minor-change tolerance at the design's own bin percentages: ` +
        outs.map((r) => `${r.sieve} ${r.deviation > 0 ? "+" : ""}${r.deviation} (±${r.tolerance})`).join(", ")
      : "Today's stockpiles still reproduce the approved curve within every minor-change tolerance at the design bin percentages.",
    drift_score: { rms_of_tolerance: r2(err.rms), worst_sieve_fraction: r2(err.worst) },
    stockpile_freshness: now.stockpile_freshness,
    stockpiles_used: now.bins_used,
    missing_gradation: now.missing_gradation,
    percent_covered: now.percent_covered,
    now_gradation: now.combined_gradation,
    jmf_gradation: target,
    voids_estimate,
    suggestion,
    caveats: [
      "If every sieve is in band and hypo Va is near design — answer is HOLD design bins, not a recovery table.",
      "RAP is locked on recovery unless allow_rap_change is set — RAP changes metered binder.",
      "Hypothetical Va uses Bailey packing RoTs; confirm on a plant sample.",
      "Beyond minor-change bands needs a revised JMF to the Division/DME.",
    ],
  };
}

function isRapBin(bin) {
  const t = String(bin.agg_type || bin.type || "").toLowerCase();
  if (/\brap\b/.test(t)) return true;
  if (String(bin.material_code ?? "") === "24033") return true;
  return false;
}

function r1pct(n) {
  return Math.round(Number(n) * 10) / 10;
}

function renormalizePercents(pcts, targetSum = 100) {
  const sum = pcts.reduce((a, b) => a + (Number(b) || 0), 0);
  if (sum <= 0) return pcts.map(() => 0);
  const scale = targetSum / sum;
  const out = pcts.map((p) => r1pct((Number(p) || 0) * scale));
  // fix rounding drift on largest bin
  const drift = r1pct(targetSum - out.reduce((a, b) => a + b, 0));
  if (drift !== 0) {
    let maxI = 0;
    for (let i = 1; i < out.length; i++) if (out[i] > out[maxI]) maxI = i;
    out[maxI] = r1pct(out[maxI] + drift);
  }
  return out;
}

// One place that knows how to name a design, so every rule check sees the same string.
function designationOf(rec) {
  if (!rec) return null;
  return String(rec.source_file || rec.mix_description || rec.design_name || "").replace(/\.xlsm?$/i, "") || null;
}

function legalPlantSplit(binsTemplate, pcts, baselinePcts, mixDesignation = null) {
  const proposed = binsTemplate.map((b, i) => ({ ...b, percent: pcts[i] }));
  const baseline = binsTemplate.map((b, i) => ({
    ...b,
    percent: baselinePcts[i] != null ? baselinePcts[i] : b.percent,
  }));
  return validateBinMove(baseline, proposed, { mix_designation: mixDesignation });
}

/**
 * Deterministic search for plant-legal bin/AC moves that push Va toward design.
 * Uses baileyCalc predict for each candidate so packing + plant rules are verified.
 *
 * @param {object} input jmf_id, sample_va, design_va?, sample_ac?, design_ac?,
 *   current_percents? (plant bins, JMF order), proposed_ac_delta? (extra AC options)
 * @param {object} ctx { getJmfRecord, getAggregateProducts }
 */
export function suggestMoves(input = {}, ctx = {}) {
  if (!ctx.getJmfRecord) {
    return { error: "suggest_moves needs getJmfRecord in context.", action: "suggest_moves" };
  }
  const rec = ctx.getJmfRecord(String(input.jmf_id || "").trim());
  if (!rec || !Array.isArray(rec.aggregates) || !rec.aggregates.length) {
    return { error: "suggest_moves needs a valid jmf_id with aggregate bins.", action: "suggest_moves" };
  }

  const designBins = rec.aggregates.map((a) => ({
    percent: a.percent,
    material_code: a.material_code,
    agg_type: a.agg_type,
    producer: a.producer,
  }));
  const n = designBins.length;
  const designPcts = designBins.map((b) => Number(b.percent) || 0);
  let currentPcts = designPcts.slice();
  if (Array.isArray(input.current_percents) && input.current_percents.length) {
    currentPcts = designBins.map((_, i) =>
      num(input.current_percents[i]) != null ? num(input.current_percents[i]) : designPcts[i]
    );
  } else if (Array.isArray(input.plant_percents) && input.plant_percents.length) {
    currentPcts = designBins.map((_, i) =>
      num(input.plant_percents[i]) != null ? num(input.plant_percents[i]) : designPcts[i]
    );
  }

  const designVa =
    num(input.design_va) ?? num((rec.design_volumetrics || {}).air_voids_pct) ?? 3.5;
  const sampleVa = num(input.sample_va);
  const designAc =
    num(input.design_ac) ??
    (rec.recycle && rec.recycle.total_ac_in_mix_pct > 0
      ? num(rec.recycle.total_ac_in_mix_pct)
      : num((rec.design_volumetrics || {}).optimum_ac_pct));
  const sampleAc = num(input.sample_ac);
  const acvc = input.acvc != null ? parseFloat(input.acvc) : DEFAULT_ACVC;
  const targetVa = num(input.target_va) ?? designVa;

  // AC vs packing residual (always returned so UI can show the strip)
  let dAc = null;
  let dVaFromAc = null;
  let residualVa = null;
  if (sampleAc != null && designAc != null) {
    dAc = r2(sampleAc - designAc);
    dVaFromAc = estimateVaFromAc(dAc, acvc).approx_delta_va;
  }
  if (sampleVa != null && designVa != null) {
    const dVaMeas = r2(sampleVa - designVa);
    residualVa = dVaFromAc != null ? r2(dVaMeas - dVaFromAc) : dVaMeas;
  }

  const diagnosis = {
    design_va: designVa,
    sample_va: sampleVa,
    target_va: targetVa,
    design_ac: designAc,
    sample_ac: sampleAc,
    delta_ac: dAc,
    approx_delta_va_from_ac: dVaFromAc,
    residual_va_after_ac: residualVa,
    problem:
      sampleVa == null
        ? "no_sample_va"
        : sampleVa < designVa - 0.15
          ? "low_voids"
          : sampleVa > designVa + 0.15
            ? "high_voids"
            : "near_target",
    packing_vs_binder:
      residualVa == null
        ? "unknown"
        : Math.abs(residualVa) < 0.15 && dVaFromAc != null && Math.abs(dVaFromAc) >= 0.15
          ? "mostly_binder"
          : Math.abs(residualVa) >= 0.25
            ? "mostly_packing"
            : "mixed",
    note:
      residualVa == null
        ? "Enter sample Va (and AC if you have it) for a full diagnosis."
        : residualVa != null && dVaFromAc != null
          ? `Measured ΔVa vs design ≈ ${r2(sampleVa - designVa)}; AC alone explains ≈ ${dVaFromAc > 0 ? "+" : ""}${dVaFromAc}. Residual ≈ ${residualVa > 0 ? "+" : ""}${residualVa} is packing/gradation.`
          : `Measured ΔVa vs design ≈ ${r2(sampleVa - designVa)} (no AC given — packing and binder not split).`,
  };

  if (sampleVa == null) {
    return {
      status: "incomplete",
      action: "suggest_moves",
      design_name: String(rec.source_file || rec.mix_description || "").replace(/\.xlsm?$/i, ""),
      diagnosis,
      moves: [],
      error: "suggest_moves needs sample_va to rank options toward target.",
    };
  }

  // ---------- Candidate search (gap-scaled) ----------
  // Tiny 1–3 pt moves cannot close a 2+ pt voids miss. Scale steps + AC to the gap,
  // hill-climb packing with a FAST Bailey estimate, then VERIFY top packages with predict.
  const products = typeof ctx.getAggregateProducts === "function" ? ctx.getAggregateProducts() : [];
  const gap = Math.abs(sampleVa - targetVa);
  const needUp = sampleVa < targetVa; // low voids → raise Va

  const candidates = [];
  const seen = new Set();
  function addCand(pcts, acDelta, label, kind) {
    const p = renormalizePercents(pcts, 100);
    const sum = p.reduce((a, b) => a + (Number(b) || 0), 0);
    if (Math.abs(sum - 100) > 0.8) return false;
    const check = legalPlantSplit(designBins, p, currentPcts);
    if (!check.ok) return false;
    const key = p.map((x) => Number(x).toFixed(1)).join(",") + "|ac:" + (acDelta || 0);
    if (seen.has(key)) return false;
    seen.add(key);
    candidates.push({
      proposed_percents: p,
      proposed_ac_delta: acDelta || 0,
      label,
      kind,
    });
    return true;
  }

  function binsFromPcts(pcts) {
    return designBins.map((b, i) => ({ ...b, percent: pcts[i] }));
  }

  /** Fast Va estimate for search (not the final answer). */
  function quickVa(pcts, acDelta) {
    const acPart = acDelta ? estimateVaFromAc(acDelta, acvc).approx_delta_va : 0;
    const curB = combineBlendGradation(binsFromPcts(currentPcts).filter((b) => num(b.percent) > 0), products);
    const propB = combineBlendGradation(binsFromPcts(pcts).filter((b) => num(b.percent) > 0), products);
    if (curB.error || propB.error || !curB.combined_gradation || !propB.combined_gradation) {
      return sampleVa + (acPart || 0);
    }
    const pack = voidsFromGradationDelta(curB.combined_gradation, propB.combined_gradation, sampleVa);
    const base = pack.ok && pack.predicted_va != null ? pack.predicted_va : sampleVa;
    return r2(base + (acPart || 0));
  }

  function towardTarget(va) {
    return -Math.abs(va - targetVa); // higher = closer
  }

  // Hold + AC-only (gap-scaled; plant can cut binder more when voids are crushed)
  addCand(currentPcts, 0, "Hold bins (no change)", "hold");
  let acSteps;
  if (diagnosis.problem === "low_voids") {
    // ACVC 2.25: −0.1 AC ≈ +0.22 Va — large gaps need bigger AC levers stacked with packing
    acSteps = gap >= 1.5 ? [-0.1, -0.2, -0.3, -0.4, -0.5] : gap >= 0.7 ? [-0.1, -0.2, -0.3] : [-0.1, -0.15, -0.2];
  } else if (diagnosis.problem === "high_voids") {
    acSteps = gap >= 1.5 ? [0.1, 0.2, 0.3, 0.4] : gap >= 0.7 ? [0.1, 0.2, 0.3] : [0.1, 0.15, 0.2];
  } else {
    acSteps = [-0.1, 0.1];
  }
  for (const d of acSteps) {
    addCand(currentPcts, d, `AC ${d > 0 ? "+" : ""}${d} pt, hold bins`, "ac_only");
  }

  const movable = [];
  for (let i = 0; i < n; i++) {
    if ((currentPcts[i] || 0) > 0 || (designPcts[i] || 0) > 0) movable.push(i);
  }

  // Gap-scaled pairwise steps (plant will dial multi-point changes when voids are crushed)
  const steps =
    gap >= 1.5 ? [1, 2, 3, 5, 7, 10] : gap >= 0.8 ? [1, 2, 3, 5, 7] : [1, 2, 3, 4];

  function tryTransfer(pcts, i, j, step) {
    if (i === j) return null;
    if (isRapBin(designBins[i]) || isRapBin(designBins[j])) return null;
    const from = pcts[i] || 0;
    const to = pcts[j] || 0;
    if (from < step - 0.01) return null;
    const next = pcts.slice();
    next[i] = r1pct(from - step);
    next[j] = r1pct(to + step);
    if (isNaturalSand(designBins[j]) && next[j] > MAX_NATURAL_SAND_PCT + 0.05) return null;
    if (next[i] > 0 && next[i] < MIN_BIN_PCT) {
      // grandfather hold or 0 only
      const base = currentPcts[i] || 0;
      if (!(base > 0 && base < MIN_BIN_PCT && next[i] >= base - 0.05)) return null;
    }
    if (!legalPlantSplit(designBins, next, currentPcts).ok) return null;
    return next;
  }

  for (const step of steps) {
    for (const i of movable) {
      for (const j of movable) {
        const next = tryTransfer(currentPcts, i, j, step);
        if (!next) continue;
        const fromLab = designBins[i].agg_type || "bin";
        const toLab = designBins[j].agg_type || "bin";
        addCand(next, 0, `Move ${step} pt: ${fromLab} → ${toLab}`, "bin_swap");
        // Always stack meaningful AC when voids are badly off (not only "mixed")
        if (gap >= 0.5) {
          for (const ac of acSteps.slice(0, 3)) {
            addCand(
              next,
              ac,
              `Move ${step} pt ${fromLab}→${toLab} + AC ${ac > 0 ? "+" : ""}${ac}`,
              "bin_and_ac"
            );
          }
        }
      }
    }
  }

  // Directed packages for low voids: pull fines/sand into #8 / coarse (raise VMA/Va on CG)
  if (needUp && gap >= 0.5) {
    const sandIs = movable.filter((i) => isNaturalSand(designBins[i]));
    const coarseIs = movable.filter((i) => {
      const t = String(designBins[i].agg_type || "").toLowerCase();
      return /#\s*8|#\s*57|#\s*5|class\s*a|class\s*b/.test(t) && !isNaturalSand(designBins[i]) && !isRapBin(designBins[i]);
    });
    const fineIs = movable.filter((i) => {
      const t = String(designBins[i].agg_type || "").toLowerCase();
      return /#\s*10|#\s*11|anti-?skid|washed|unwashed/.test(t) && !isNaturalSand(designBins[i]) && !isRapBin(designBins[i]);
    });
    const packageSteps = gap >= 1.5 ? [3, 5, 7] : [2, 3, 5];
    for (const step of packageSteps) {
      for (const s of sandIs) {
        for (const c of coarseIs) {
          const next = tryTransfer(currentPcts, s, c, step);
          if (!next) continue;
          addCand(next, 0, `Package: −${step} sand → +${step} coarse`, "package");
          for (const ac of acSteps.slice(0, 4)) {
            addCand(next, ac, `Package: −${step} sand → coarse + AC ${ac > 0 ? "+" : ""}${ac}`, "package_ac");
          }
        }
      }
      for (const f of fineIs) {
        for (const c of coarseIs) {
          const next = tryTransfer(currentPcts, f, c, step);
          if (!next) continue;
          addCand(next, 0, `Package: −${step} fines → +${step} coarse`, "package");
          for (const ac of acSteps.slice(0, 3)) {
            addCand(next, ac, `Package: −${step} fines → coarse + AC ${ac > 0 ? "+" : ""}${ac}`, "package_ac");
          }
        }
      }
    }
  }

  // Hill-climb: repeatedly take the best 1–2 pt legal transfer by quick Va toward target
  {
    let climb = currentPcts.slice();
    let climbVa = quickVa(climb, 0);
    const climbSteps = gap >= 1.2 ? [1, 2] : [1];
    const maxIter = gap >= 1.5 ? 18 : gap >= 0.8 ? 12 : 8;
    const path = [];
    for (let iter = 0; iter < maxIter; iter++) {
      let best = null;
      for (const step of climbSteps) {
        for (const i of movable) {
          for (const j of movable) {
            const next = tryTransfer(climb, i, j, step);
            if (!next) continue;
            const va = quickVa(next, 0);
            if (towardTarget(va) > towardTarget(climbVa) + 0.015) {
              if (!best || towardTarget(va) > towardTarget(best.va)) {
                best = {
                  next,
                  va,
                  label: `Climb ${step}: ${designBins[i].agg_type || "bin"} → ${designBins[j].agg_type || "bin"}`,
                };
              }
            }
          }
        }
      }
      if (!best) break;
      climb = best.next;
      climbVa = best.va;
      path.push(best.label);
      addCand(climb, 0, `Hill-climb packing (${path.length} steps) → ~${climbVa}% Va`, "hill_climb");
      // Stack AC on the climbed packing state
      for (const ac of acSteps) {
        const vaAc = quickVa(climb, ac);
        addCand(
          climb,
          ac,
          `Hill-climb packing + AC ${ac > 0 ? "+" : ""}${ac} → ~${vaAc}% Va`,
          "hill_climb_ac"
        );
      }
      // Close enough
      if (Math.abs(climbVa - targetVa) < 0.2) break;
    }
  }

  // Rank candidates by quick Va closeness to target (prefer real progress, not tiny moves)
  const ranked = candidates
    .map((c) => {
      const q = quickVa(c.proposed_percents, c.proposed_ac_delta || 0);
      const err = Math.abs(q - targetVa);
      const wrongWay =
        (needUp && q < sampleVa - 0.05) || (!needUp && diagnosis.problem === "high_voids" && q > sampleVa + 0.05);
      const pts =
        c.proposed_percents.reduce((s, p, i) => s + Math.abs(p - (currentPcts[i] || 0)), 0) / 2;
      // Primary: closer to 3.5 wins. Secondary: prefer some movement when gap large. Tiny AC cost.
      const score = wrongWay
        ? -100
        : -err * 20 + (sampleVa !== q ? Math.min(Math.abs(q - sampleVa), gap) * 2 : 0) - Math.abs(c.proposed_ac_delta || 0) * 0.15 - pts * 0.02;
      return { ...c, quick_va: q, quick_err: err, score };
    })
    .filter((c) => c.score > -50)
    .sort((a, b) => b.score - a.score);

  // Verify top packages with full predict (truth for the UI)
  const MAX_VERIFY = 14;
  const toVerify = ranked.slice(0, MAX_VERIFY);
  // Always include pure AC options and best hill-climbs if not already in top
  for (const c of ranked) {
    if (toVerify.length >= MAX_VERIFY) break;
    if (c.kind === "ac_only" || c.kind === "hill_climb" || c.kind === "hill_climb_ac" || c.kind === "package_ac") {
      if (!toVerify.find((x) => x.label === c.label && x.proposed_ac_delta === c.proposed_ac_delta)) {
        toVerify.push(c);
      }
    }
  }

  const scored = [];
  for (const c of toVerify) {
    const pred = baileyCalc(
      {
        action: "predict",
        jmf_id: rec.jmf_id,
        current_percents: currentPcts,
        proposed_percents: c.proposed_percents,
        proposed_ac_delta: c.proposed_ac_delta || 0,
        sample_va: sampleVa,
        design_va: designVa,
        acvc,
      },
      ctx
    );
    if (pred.error || (pred.plant_rules && pred.plant_rules.ok === false)) continue;
    let pVa =
      pred.prediction && pred.prediction.predicted_va != null ? pred.prediction.predicted_va : null;
    if (pVa == null && c.proposed_ac_delta) {
      pVa = r2(sampleVa + estimateVaFromAc(c.proposed_ac_delta, acvc).approx_delta_va);
    }
    // Fall back to quick if packing path failed but quick had a number
    if (pVa == null && c.quick_va != null) pVa = c.quick_va;
    if (pVa == null) continue;

    const errNow = Math.abs(sampleVa - targetVa);
    const errPred = Math.abs(pVa - targetVa);
    const improvement = errNow - errPred;
    if (needUp && pVa < sampleVa - 0.05) continue;
    if (diagnosis.problem === "high_voids" && pVa > sampleVa + 0.05) continue;

    const overshoot = Math.max(0, errPred - 0.08);
    // Rank almost entirely by closeness to design Va (3.5) — that is the job
    const score = -errPred * 25 + improvement * 8 - overshoot * 3 - Math.abs(c.proposed_ac_delta || 0) * 0.2;

    const binChanges = designBins
      .map((b, i) => ({
        agg_type: b.agg_type,
        material_code: b.material_code,
        from: currentPcts[i],
        to: c.proposed_percents[i],
        delta: r1pct(c.proposed_percents[i] - currentPcts[i]),
      }))
      .filter((row) => Math.abs(row.delta) >= 0.05);

    scored.push({
      rank: 0,
      score: r2(score),
      label: c.label,
      kind: c.kind,
      proposed_percents: c.proposed_percents,
      proposed_ac_delta: c.proposed_ac_delta || null,
      bin_changes: binChanges,
      plant_rules_ok: true,
      predicted_va: pVa,
      approx_delta_va: r2(pVa - sampleVa),
      improvement_toward_target: r2(improvement),
      shortfall_to_target: r2(errPred),
      target_va: targetVa,
      verdict: pred.verdict || null,
      verdict_text: pred.verdict_text || null,
      packing_note: (pred.prediction && pred.prediction.packing_note) || null,
      prediction: pred.prediction || null,
    });
  }

  // Closest to target first
  scored.sort((a, b) => {
    const ea = Math.abs(a.predicted_va - targetVa);
    const eb = Math.abs(b.predicted_va - targetVa);
    if (Math.abs(ea - eb) > 0.04) return ea - eb;
    return b.score - a.score;
  });

  let top = scored.filter((m) => m.kind !== "hold");
  if (!top.length) top = scored.slice(0, 1);

  // Diversity: different primary bin lever and/or AC
  const picked = [];
  const usedSig = new Set();
  for (const m of top) {
    const main =
      (m.bin_changes || []).slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0] || null;
    const sig =
      (main ? main.agg_type + ":" + Math.sign(main.delta) : "ac") +
      "|ac:" +
      (m.proposed_ac_delta || 0) +
      "|k:" +
      (m.kind || "");
    if (usedSig.has(sig) && picked.length) continue;
    usedSig.add(sig);
    picked.push(m);
    if (picked.length >= 3) break;
  }
  picked.forEach((m, i) => {
    m.rank = i + 1;
  });

  const best = picked[0];
  const bestErr = best ? Math.abs(best.predicted_va - targetVa) : null;
  const shortfallNote =
    best && bestErr != null && bestErr > 0.45
      ? `Best verified option still ~${r2(bestErr)} pts from design Va ${targetVa}% (pred ${best.predicted_va}%). ` +
        (best.proposed_ac_delta
          ? "Stack more AC only with lab confirmation; "
          : "Pair the packing move with an AC cut (low voids) or AC bump (high voids); ") +
        "if still short, material/stockpile may have shifted — consider JMF comparison recovery or a revised JMF."
      : null;

  // Coverage / freshness for confidence badge
  const covBlend = combineBlendGradation(
    designBins.map((b, i) => ({ ...b, percent: currentPcts[i] })).filter((b) => num(b.percent) > 0),
    products
  );
  const covPct = Number(covBlend.percent_covered) || 0;
  const missN = (covBlend.missing_gradation || []).length;
  const freshTxt = covBlend.stockpile_freshness || "";
  for (const m of picked) {
    const packPart =
      m.prediction && m.prediction.approx_delta_va_from_packing != null
        ? m.prediction.approx_delta_va_from_packing
        : m.proposed_ac_delta && m.approx_delta_va != null
          ? r2(m.approx_delta_va - (estimateVaFromAc(m.proposed_ac_delta, acvc).approx_delta_va || 0))
          : m.approx_delta_va;
    m.confidence = predictionConfidence({
      percent_covered: covPct,
      missing_count: missN,
      stockpile_freshness: freshTxt,
      packing_delta_va: m.kind === "ac_only" ? 0 : packPart,
      ac_delta: m.proposed_ac_delta,
      packing_available: !(covBlend.error || covPct < 25),
      context: "suggest_moves",
    });
  }
  const confidence = best && best.confidence
    ? best.confidence
    : predictionConfidence({
        percent_covered: covPct,
        missing_count: missN,
        stockpile_freshness: freshTxt,
        packing_available: !(covBlend.error || covPct < 25),
      });

  const mixName = String(rec.source_file || rec.mix_description || "").replace(/\.xlsm?$/i, "");
  return {
    status: picked.length ? "ok" : "no_moves",
    action: "suggest_moves",
    jmf_id: rec.jmf_id,
    design_name: mixName,
    diagnosis,
    current_percents: currentPcts,
    design_percents: designPcts,
    bins: designBins.map((b, i) => ({
      agg_type: b.agg_type,
      material_code: b.material_code,
      producer: b.producer,
      design_pct: designPcts[i],
      current_pct: currentPcts[i],
    })),
    target_va: targetVa,
    voids_gap: r2(gap),
    candidates_evaluated: candidates.length,
    verified: toVerify.length,
    moves: picked,
    confidence,
    stockpile_coverage: covPct,
    shortfall_note: shortfallNote,
    how_to_use: [
      "Present Do now as move #1 (verified). Quote predicted Va vs design target and confidence level.",
      "If shortfall_note is set, say clearly the field move only partially closes the gap — AC stack and/or JMF recovery may be needed.",
      "Offer #2–#3 as alternates. Magnitudes are Bailey RoT + ACVC — confirm on next sample.",
    ],
    note:
      picked.length === 0
        ? "No legal move improved predicted Va toward target. Check sample quality, stockpile sieves, or AC measurement."
        : `${picked.length} verified option(s) aiming at design Va ${targetVa}% (gap was ${r2(gap)} pts).` +
          (shortfallNote ? " " + shortfallNote : ""),
  };
}

/**
 * Tool entrypoint — routes action.
 * @param {object} input
 * @param {object} [ctx] optional { getJmfRecord(id), getAggregateProducts() }
 */
export function baileyCalc(input = {}, ctx = {}) {
  const action = String(input.action || "analyze").toLowerCase();

  // Optional JMF hydrate for design side
  if (input.jmf_id && ctx.getJmfRecord) {
    const rec = ctx.getJmfRecord(String(input.jmf_id).trim());
    if (!rec) {
      return {
        error: `No JMF matched "${input.jmf_id}".`,
        hint: "Pass design_gradation manually or a valid jmf_id.",
      };
    }
    if (!input.design_gradation && rec.jmf_gradation_mm) {
      input = {
        ...input,
        design_gradation: rec.jmf_gradation_mm,
        design_ac:
          input.design_ac ??
          // total AC of 0 = bad parse data, never a real target — fall back to optimum
          (rec.recycle && rec.recycle.total_ac_in_mix_pct != null && rec.recycle.total_ac_in_mix_pct > 0
            ? rec.recycle.total_ac_in_mix_pct
            : (rec.design_volumetrics || {}).optimum_ac_pct),
        design_va: input.design_va ?? (rec.design_volumetrics || {}).air_voids_pct,
        design_vma: input.design_vma ?? (rec.design_volumetrics || {}).vma_pct,
        _jmf: {
          jmf_id: rec.jmf_id,
          name: String(rec.source_file || rec.mix_description || "").replace(/\.xlsm?$/i, ""),
          gmm: (rec.design_volumetrics || {}).gmm,
          bins: (rec.aggregates || []).map((a) => ({
            pct: a.percent,
            type: a.agg_type,
            producer: a.producer,
            material_code: a.material_code,
          })),
          rap_pct: rec.recycle ? rec.recycle.rap_total_pct : null,
        },
      };
    }
  }

  if (action === "ac_effect") {
    const d =
      input.proposed_ac_delta != null
        ? input.proposed_ac_delta
        : num(input.sample_ac) != null && num(input.design_ac) != null
          ? num(input.sample_ac) - num(input.design_ac)
          : null;
    if (d == null) {
      return { error: "ac_effect needs proposed_ac_delta, or design_ac + sample_ac." };
    }
    return { status: "ok", action: "ac_effect", ...estimateVaFromAc(d, input.acvc) };
  }

  if (action === "ratios") {
    const grad = normalizeGradation(input.gradation || input.sample_gradation || input.design_gradation || {});
    if (!Object.keys(grad).length) return { error: "ratios needs a gradation object." };
    const nmas = input.nmas_mm != null ? parseFloat(input.nmas_mm) : baileyNmas(grad);
    if (nmas == null) return { error: "Could not determine NMAS." };
    const controls = controlSieves(nmas);
    const classification = classifyMixType(grad, controls);
    return {
      status: "ok",
      action: "ratios",
      nmas_mm: nmas,
      controls,
      mix_classification: classification,
      ratios: computeRatios(grad, controls),
    };
  }

  if (action === "blend_estimate") {
    return blendEstimate(input, ctx);
  }

  if (action === "spec_check") {
    const r = specCheck(input);
    if (input._jmf) r.jmf_used = { jmf_id: input._jmf.jmf_id, name: input._jmf.name };
    return r;
  }

  if (action === "jmf_drift") return jmfDrift(input, ctx);

  // Deterministic option search for out-of-spec Va / bin advice
  if (action === "suggest_moves") {
    return suggestMoves(input, ctx);
  }

  // Tech-facing "what if": design bins vs proposed % → Bailey + plant rules + rough Va
  if (action === "predict") {
    let rec = null;
    if (input.jmf_id && ctx.getJmfRecord) {
      rec = ctx.getJmfRecord(String(input.jmf_id).trim());
    }
    if (!rec || !Array.isArray(rec.aggregates) || !rec.aggregates.length) {
      return { error: "predict needs a valid jmf_id with aggregate bins." };
    }
    const designBins = rec.aggregates.map((a) => ({
      percent: a.percent,
      material_code: a.material_code,
      agg_type: a.agg_type,
      producer: a.producer,
    }));
    // Optional plant/current split (same order as JMF aggregates) — What if / suggest_moves
    const currentBins = Array.isArray(input.current_percents)
      ? designBins.map((b, i) => ({
          ...b,
          percent: num(input.current_percents[i]) != null ? num(input.current_percents[i]) : b.percent,
        }))
      : designBins;
    // proposed_percents: array of numbers in same order as JMF aggregates, or proposed_bins full objects
    let proposedBins = null;
    if (Array.isArray(input.proposed_bins) && input.proposed_bins.length) {
      proposedBins = input.proposed_bins;
    } else if (Array.isArray(input.proposed_percents)) {
      proposedBins = designBins.map((b, i) => ({
        ...b,
        percent: num(input.proposed_percents[i]) != null ? num(input.proposed_percents[i]) : b.percent,
      }));
    } else {
      return { error: "predict needs proposed_percents[] (same order as JMF aggregates) or proposed_bins[]." };
    }

    // Active bins only for blend math (0% = removed). Current = plant if provided, else design.
    const designActive = currentBins.filter((b) => num(b.percent) > 0);
    const proposedActive = proposedBins.filter((b) => num(b.percent ?? b.pct) > 0);

    let est = blendEstimate(
      {
        jmf_id: input.jmf_id,
        bins: designActive,
        proposed_bins: proposedActive,
        mix_type: input.mix_type,
        nmas_mm: input.nmas_mm,
      },
      ctx
    );

    // Plant rules always from full proposed list (incl. zeros) with current/design baseline
    const plantCheck = validateBinMove(currentBins, proposedBins);
    if (est && typeof est === "object") {
      est = {
        ...est,
        plant_rules: {
          min_bin_pct: MIN_BIN_PCT,
          max_natural_sand_pct: MAX_NATURAL_SAND_PCT,
          summary: PLANT_RULES_SUMMARY,
          check: plantCheck,
          ok: plantCheck.ok,
        },
        status: !plantCheck.ok ? "rule_violation" : est.status,
      };
    }

    const designVa = num(input.design_va) ?? num((rec.design_volumetrics || {}).air_voids_pct);
    const sampleVa = num(input.sample_va);
    const baseVa = sampleVa != null ? sampleVa : designVa;
    const acDelta = num(input.proposed_ac_delta) ?? 0;
    const acvc = input.acvc != null ? parseFloat(input.acvc) : DEFAULT_ACVC;
    const acOnly = acDelta !== 0 ? estimateVaFromAc(acDelta, acvc) : null;

    // Build stockpile-weighted blends (needs getAggregateProducts on the calc endpoint)
    const products = typeof ctx.getAggregateProducts === "function" ? ctx.getAggregateProducts() : [];
    let curBlend = combineBlendGradation(designActive, products);
    let propBlend = combineBlendGradation(proposedActive, products);
    let coverage = Math.min(
      Number(curBlend.percent_covered || 0) || 0,
      Number(propBlend.percent_covered || 0) || 0
    );
    // Fallback: design JMF gradation as current when stockpile match is thin
    const designGrad = normalizeGradation(rec.jmf_gradation_mm || {});
    let blendSource = "stockpile";
    if (
      (curBlend.error || coverage < 40) &&
      Object.keys(designGrad).length >= 4
    ) {
      curBlend = {
        combined_gradation: designGrad,
        bins_used: designActive.map((b) => ({
          percent: b.percent,
          agg_type: b.agg_type,
          material_code: b.material_code,
          producer: b.producer,
          source: "jmf_design",
        })),
        percent_covered: 100,
        missing_gradation: curBlend.missing_gradation || [],
        note: "Current blend = approved design gradation (stockpile match incomplete).",
      };
      // Proposed: stockpile if usable, else design + coarse bin-lever shift is not applied —
      // re-use stockpile proposed when it has any coverage, else keep design (Δ from AC only path).
      if (propBlend.error || !(Number(propBlend.percent_covered || 0) >= 25)) {
        // Approximate proposed by reweighting known stockpiles + renormalize; if still empty, design
        if (propBlend.error || !propBlend.combined_gradation) {
          propBlend = {
            combined_gradation: designGrad,
            bins_used: [],
            percent_covered: 0,
            missing_gradation: propBlend.missing_gradation || [],
            note: "Proposed used design gradation — stockpile sieves missing for bin move estimate.",
          };
          blendSource = "design_only";
        } else {
          blendSource = "design_current_stockpile_proposed";
        }
      } else {
        blendSource = "design_current_stockpile_proposed";
      }
      coverage = Math.min(
        Number(curBlend.percent_covered || 0) || 0,
        Number(propBlend.percent_covered || 0) || 0
      );
    }
    const hasBlend =
      !curBlend.error &&
      !propBlend.error &&
      curBlend.combined_gradation &&
      propBlend.combined_gradation &&
      (coverage >= 25 || blendSource !== "stockpile");

    let dVma = null;
    let packingNote = "";
    let cr = null;
    let pr = null;
    let mixTypeUsed = "coarse";

    if (hasBlend && blendSource !== "design_only") {
      const nmas =
        input.nmas_mm != null && Number.isFinite(parseFloat(input.nmas_mm))
          ? parseFloat(input.nmas_mm)
          : baileyNmas(curBlend.combined_gradation) || baileyNmas(propBlend.combined_gradation);
      const controls = nmas != null ? controlSieves(nmas) : null;
      const classification = controls ? classifyMixType(curBlend.combined_gradation, controls) : { mix_type: "coarse" };
      mixTypeUsed =
        classification.mix_type === "fine"
          ? "fine"
          : classification.mix_type === "sma" || classification.mix_type === "sma_candidate"
            ? "sma"
            : "coarse";
      if (controls) {
        cr = computeRatios(curBlend.combined_gradation, controls);
        pr = computeRatios(propBlend.combined_gradation, controls);
        const fromRoT = estimateVmaDeltas(
          mixTypeUsed,
          cr,
          pr,
          cr.sieves && cr.sieves.pcs ? cr.sieves.pcs.pct_passing : null,
          pr.sieves && pr.sieves.pcs ? pr.sieves.pcs.pct_passing : null
        );
        dVma = fromRoT.total_approx_vma;
        const comps = fromRoT.components || [];
        let dominant = null;
        for (const c of comps) {
          if (dominant == null || Math.abs(c.approx_delta_vma || 0) > Math.abs(dominant.approx_delta_vma || 0)) {
            dominant = c;
          }
        }
        // If components cancel to ~0 but control sieves moved a lot, use dominant lever
        if ((dVma == null || Math.abs(dVma) < 0.1) && dominant && Math.abs(dominant.approx_delta_vma || 0) >= 0.1) {
          dVma = dominant.approx_delta_vma;
          packingNote = `Main packing lever: ${dominant.lever}.`;
        }
        // Extra: if still tiny but %PCS moved ≥2 points, force PCS RoT
        const pcs0 = cr.sieves && cr.sieves.pcs ? cr.sieves.pcs.pct_passing : null;
        const pcs1 = pr.sieves && pr.sieves.pcs ? pr.sieves.pcs.pct_passing : null;
        if (pcs0 != null && pcs1 != null && Math.abs(pcs1 - pcs0) >= 2) {
          const sens = mixTypeUsed === "fine" ? 6 : mixTypeUsed === "sma" ? 2 : 4;
          const sign = mixTypeUsed === "fine" ? 1 : -1;
          const dPcsVma = r2(sign * ((pcs1 - pcs0) / sens));
          if (dVma == null || Math.abs(dPcsVma) > Math.abs(dVma)) {
            dVma = dPcsVma;
            packingNote = `From %PCS move ${r1(pcs0)}→${r1(pcs1)} (Bailey PCS sensitivity).`;
          }
        }
        est = {
          ...est,
          mix_type_used: mixTypeUsed,
          current: {
            ratios: cr,
            combined_gradation: curBlend.combined_gradation,
            bins_used: curBlend.bins_used,
            percent_covered: curBlend.percent_covered,
            missing_gradation: curBlend.missing_gradation,
            stockpile_freshness: curBlend.stockpile_freshness,
            note: curBlend.note,
          },
          proposed: {
            ratios: pr,
            combined_gradation: propBlend.combined_gradation,
            bins_used: propBlend.bins_used,
            percent_covered: propBlend.percent_covered,
            missing_gradation: propBlend.missing_gradation,
            note: propBlend.note,
          },
          vma_sensitivity_estimate: fromRoT,
          blend_source: blendSource,
        };
        packingNote =
          packingNote ||
          (blendSource === "stockpile"
            ? `Stockpile-weighted blend (${coverage}% coverage). ΔVMA from Bailey ratio rules-of-thumb.`
            : `Design gradation + stockpile proposed (${coverage}% stockpile). ΔVMA from Bailey RoTs.`);
      }
    } else if (hasBlend && blendSource === "design_only") {
      packingNote =
        "No stockpile sieves for this mix's bins — packing ΔVMA not estimated. Plant rules and AC still apply. Upload wash sieves or pick a mix with full stockpile data.";
      dVma = null;
      est = {
        ...est,
        current: {
          combined_gradation: designGrad,
          percent_covered: 0,
          missing_gradation: curBlend.missing_gradation,
          note: curBlend.note,
        },
        blend_source: blendSource,
      };
    } else {
      packingNote =
        "Stockpile coverage too low for packing math — plant rules still checked. Fill missing wash-sieve tags or use a mix with full stockpile data.";
      dVma = null;
    }

    // Bailey: voids largely follow VMA at constant binder volume; AC is a separate lever
    const dVaStruct = dVma;
    const dVaAc = acOnly ? acOnly.approx_delta_va : 0;
    let dVaTotal = null;
    if (dVaStruct != null || (acOnly && acOnly.approx_delta_va != null)) {
      dVaTotal = r2((dVaStruct || 0) + (dVaAc || 0));
    }
    const predictedVa = baseVa != null && dVaTotal != null ? r2(baseVa + dVaTotal) : null;

    const rulesOk = plantCheck.ok;
    let verdict = "caution";
    let verdict_text = "Review the ratio moves before running.";
    if (!rulesOk) {
      verdict = "bad";
      verdict_text =
        plantCheck.summary ||
        "Plant bin rules broken — active bins need ≥10% (0% = remove OK); natural sand ≤15%.";
    } else if (!hasBlend || dVma == null) {
      verdict = "caution";
      verdict_text = packingNote || "Plant rules OK, but packing/voids could not be estimated from stockpiles.";
    } else if (dVaTotal != null && Math.abs(dVaTotal) < 0.12) {
      verdict = "neutral";
      verdict_text = "Small predicted voids move — fine for a conservative tweak; confirm with next sample.";
    } else if (dVaTotal != null) {
      if (sampleVa != null && designVa != null && predictedVa != null) {
        const errNow = sampleVa - designVa;
        const errPred = predictedVa - designVa;
        if (Math.abs(errPred) < Math.abs(errNow) - 0.05) {
          verdict = "good";
          verdict_text = "Predicted to move air voids toward the design target (Bailey RoT + plant rules OK).";
        } else if (Math.abs(errPred) > Math.abs(errNow) + 0.1) {
          verdict = "caution";
          verdict_text = "May move voids farther from design — check direction of the bin move.";
        } else {
          verdict = "caution";
          verdict_text = "Plant rules OK; voids effect is modest — confirm on the next sample.";
        }
      } else {
        verdict = "good";
        verdict_text =
          "Plant rules OK; Bailey estimates packing change ΔVa ≈ " +
          (dVaTotal > 0 ? "+" : "") +
          dVaTotal +
          "% (from ~" +
          baseVa +
          "% → ~" +
          predictedVa +
          "%). Confirm with next sample.";
      }
    }

    const binTable = designBins.map((b, i) => ({
      material_code: b.material_code,
      agg_type: b.agg_type,
      producer: b.producer,
      design_pct: b.percent,
      proposed_pct: num(proposedBins[i] && (proposedBins[i].percent ?? proposedBins[i].pct)),
      delta_pct:
        num(proposedBins[i] && (proposedBins[i].percent ?? proposedBins[i].pct)) != null && b.percent != null
          ? r1(num(proposedBins[i].percent ?? proposedBins[i].pct) - b.percent)
          : null,
    }));

    const confidence = predictionConfidence({
      percent_covered: coverage,
      missing_count:
        ((curBlend.missing_gradation || []).length + (propBlend.missing_gradation || []).length) / 2,
      stockpile_freshness:
        (curBlend.stockpile_freshness || "") + " " + (propBlend.stockpile_freshness || ""),
      packing_delta_va: dVaStruct,
      ac_delta: acDelta,
      packing_available: !!(hasBlend && blendSource !== "design_only"),
      context: "predict",
    });

    return {
      status: est.status === "rule_violation" ? "rule_violation" : est.status === "ok" ? "ok" : est.status,
      action: "predict",
      jmf_id: rec.jmf_id,
      mix_name: rec.source_file || rec.mix_description,
      design_va: designVa,
      sample_va: sampleVa,
      base_va_used: baseVa,
      bin_table: binTable,
      plant_rules: est.plant_rules,
      blend: est,
      confidence,
      prediction: {
        approx_delta_vma: dVma,
        approx_delta_va_from_packing: dVaStruct,
        approx_delta_va_from_ac: dVaAc,
        approx_delta_va_total: dVaTotal,
        predicted_va: predictedVa,
        proposed_ac_delta: acDelta || null,
        packing_note: packingNote,
        confidence,
        method:
          "ΔVMA from Bailey ratio RoTs on stockpile-weighted blend (design bins vs proposed). " +
          "ΔVa_packing ≈ ΔVMA (voids follow VMA). ΔVa_AC ≈ −ACVC×ΔAC. 0% bins = removed. Advisory — not a lab result.",
      },
      verdict,
      verdict_text,
      how_to_use: [
        "Show verdict + predicted Va + confidence first; plant_rules must be green before running.",
        "Magnitudes are rules-of-thumb — confirm with the next burn-off / Va test.",
      ],
    };
  }

  // default analyze
  const result = analyze(input);
  if (input._jmf && result.status === "ok") result.jmf_used = input._jmf;
  return result;
}

export default baileyCalc;
