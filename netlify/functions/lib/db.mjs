// =============================================================================
// DBT (Danville) Supabase data layer
// -----------------------------------------------------------------------------
// Replaces BT3's five bundled .mjs snapshots with live reads. The contract is
// that every function here returns the SAME SHAPE BT3's tools returned, so
// bailey_calc.mjs (copied byte-identical) and the answer doctrine port
// unchanged. Match the shapes and nothing downstream needs to know the data
// moved. That is the highest-leverage decision in the port (brief §3.5 step 3).
//
// Dependencies: none. PostgREST over global fetch keeps package.json at one
// dependency; @supabase/supabase-js would buy us nothing the REST API lacks.
//
// location_id is a PARAMETER, defaulting to 4 (Danville). BT3 is 1. Threading it
// through now costs nothing; retrofitting it later costs every call site plus a
// golden-suite re-run (brief §3.7 item 5). Nothing else is built for BT3's sake.
// =============================================================================

import { SIEVE_MM_TO_LABEL } from "./bailey_calc.mjs";

export const DEFAULT_LOCATION_ID = 4;

// Env reader. Routed through one helper on purpose: BT3 read ANTHROPIC_MODEL and
// ANTHROPIC_EFFORT with bare process.env while everything else used a helper, so
// on a runtime that only populates Netlify.env those two silently fell back to
// defaults with no error. Every read here goes through this.
function envGet(name) {
  try { if (process.env && process.env[name]) return process.env[name]; } catch { /* no process */ }
  try {
    // eslint-disable-next-line no-undef
    if (typeof Netlify !== "undefined" && Netlify.env?.get) {
      const v = Netlify.env.get(name);
      if (v) return v;
    }
  } catch { /* not that runtime */ }
  return undefined;
}

// -----------------------------------------------------------------------------
// Sieve keys — trap §2.6, and it is live here
// -----------------------------------------------------------------------------
// bailey_calc's canonical keys are the SIEVE_MM_TO_LABEL keys: "50.0", "37.5",
// "25.0", "19.0", "12.5", "9.5", "4.75", "2.36", "1.18", "0.6", "0.3", "0.15",
// "0.075". PostgREST returns sieves.opening_mm as a NUMERIC STRING with trailing
// zeros — "50.0000", not "50.0". A plain string key would produce
// {"50.0000": 100}, and while bailey_calc's mmKey() does match numerically, its
// SIEVE_MM_TO_LABEL lookups and any object-key comparison would miss. So we
// resolve every opening back to the canonical key string, and refuse to invent
// one for an opening we do not recognise.
const CANONICAL_MM_KEYS = Object.keys(SIEVE_MM_TO_LABEL);

export function sieveKeyFromMm(openingMm) {
  // PAN has opening_mm = NULL in the sieves table. parseFloat(null) is NaN, and
  // a NaN key would serialise as "NaN" and poison the gradation object.
  if (openingMm === null || openingMm === undefined || openingMm === "") return null;
  const n = typeof openingMm === "number" ? openingMm : parseFloat(String(openingMm));
  if (!Number.isFinite(n)) return null;
  for (const k of CANONICAL_MM_KEYS) {
    if (Math.abs(parseFloat(k) - n) < 1e-6) return k;
  }
  return null; // unknown opening — dropped rather than guessed at
}

/** Rows of {opening_mm, pct_passing} -> {"9.5": 94.2, ...} in canonical keys. */
export function gradationFromRows(rows) {
  const out = {};
  const dropped = [];
  for (const r of rows || []) {
    const key = sieveKeyFromMm(r.opening_mm);
    const pct = r.pct_passing === null || r.pct_passing === undefined
      ? null : Number(r.pct_passing);
    if (key === null) {
      if (r.label) dropped.push(String(r.label));
      continue;
    }
    if (pct === null || !Number.isFinite(pct)) continue;
    out[key] = pct;
  }
  return { gradation_mm: out, dropped_sieves: dropped };
}

// -----------------------------------------------------------------------------
// Material display names — the single choke point
// -----------------------------------------------------------------------------
// Non-negotiable 7: techs speak in names, ids never appear in an answer. At
// Danville a bare size label is NOT a name: materials.aggregate_type is
// literally "#10" for BOTH Caldwell Stone (id 50) and Dix River Quarry (id 16),
// and materials.description is NULL for all 14. Same size, different quarry,
// and for the dolomites a different rock type — so picking the wrong one
// silently changes the polish-resistant math.
//
// The name is DERIVED here rather than stored, so there is one source of truth
// (the source + size + wash columns) instead of a description column that drifts.

/**
 * "Rogers Group at Caldwell Stone" -> "Caldwell Stone". Jake calls that quarry
 * "Caldwell Stone", and the operator prefix is noise to a tech.
 *
 * Deliberately handles " at " ONLY, not " @ ". BT3's producer strings look like
 * "Gaddie Shamrock @ Columbia", where the tail is the CITY -- stripping on "@"
 * would rename the quarry to "Columbia". Danville's locations.name values use
 * "at" and none of them hide a city there. If a location ever does, this rule
 * needs revisiting rather than extending.
 */
export function shortSource(sourceName) {
  const s = String(sourceName || "").trim();
  if (!s) return "";
  const m = s.match(/\s+at\s+(.+)$/i);
  return (m ? m[1] : s).trim();
}

export function materialDisplayName(m, opts = {}) {
  const plantSourceId = opts.plantSourceId ?? null;
  const base = String(m.aggregate_type || m.size_desig || "material").trim();
  const src = shortSource(m.source_name);

  const qual = [];
  const size = String(m.size_desig || "").trim();
  if (size && !base.toLowerCase().includes(size.toLowerCase())) qual.push(size);
  const wash = String(m.wash || "").trim();
  if (wash && wash !== "unspecified" && !/washed/i.test(base)) qual.push(wash);

  const suffix = qual.length ? ` (${qual.join(", ")})` : "";

  // RAP is produced by the plant itself. "Danville Asphalt Plant Fine RAP" reads
  // like a different quarry; the tech just calls it RAP.
  if (plantSourceId != null && Number(m.source_id) === Number(plantSourceId)) {
    return `${base}${suffix}`;
  }
  return src ? `${src} ${base}${suffix}` : `${base}${suffix}`;
}

/**
 * Assigns display names across a location's materials and reports any that are
 * still not unique. A collision is a correctness problem, not cosmetics: two
 * materials the agent cannot tell apart in an answer.
 */
export function nameMaterials(materials, opts = {}) {
  const named = (materials || []).map((m) => ({ ...m, display_name: materialDisplayName(m, opts) }));
  const seen = new Map();
  for (const m of named) {
    const list = seen.get(m.display_name) || [];
    list.push(m);
    seen.set(m.display_name, list);
  }
  const collisions = [];
  for (const [name, list] of seen) {
    if (list.length > 1) collisions.push({ display_name: name, count: list.length });
  }
  return { materials: named, collisions };
}

// -----------------------------------------------------------------------------
// Freshness — now() - test_date, not a manual chore (brief §3.1)
// -----------------------------------------------------------------------------
// BT3 computed this from PDF upload dates because Jake uploaded the PDFs. Here
// it is a column. Thresholds mirror BT3's gradation_status vocabulary so the
// doctrine's language about stale stockpile data ports unchanged.
export function freshness(testDate, now = new Date()) {
  if (!testDate) return { status: "missing", age_days: null, tested_on: null };
  const t = new Date(testDate);
  if (Number.isNaN(t.getTime())) return { status: "missing", age_days: null, tested_on: null };
  const ageDays = Math.floor((now.getTime() - t.getTime()) / 86400000);
  const status = ageDays <= 14 ? "current" : ageDays <= 45 ? "aging" : "stale";
  return { status, age_days: ageDays, tested_on: String(testDate).slice(0, 10) };
}

// -----------------------------------------------------------------------------
// PostgREST client
// -----------------------------------------------------------------------------
class DbError extends Error {
  constructor(msg, { status = null, path = null } = {}) {
    super(msg);
    this.name = "DbError";
    this.status = status;
    this.path = path;
  }
}
export { DbError };

export function createDb(opts = {}) {
  const url = (opts.url ?? envGet("SUPABASE_URL") ?? "").replace(/\/+$/, "");
  const key = opts.serviceKey ?? envGet("SUPABASE_SERVICE_ROLE_KEY");
  const locationId = Number(opts.locationId ?? DEFAULT_LOCATION_ID);
  const ttlMs = Number(opts.ttlMs ?? 5 * 60 * 1000);
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? (() => new Date());

  if (!url || !key) {
    throw new DbError(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set (server-side only)."
    );
  }

  // In-process TTL cache. The function stays warm between invocations and the
  // design catalog changes weekly, so re-fetching per request would spend the
  // 60s budget (§2.2) on data that did not move. Sample reads are NOT cached.
  const cache = new Map();
  async function cached(cacheKey, ttl, fn) {
    const hit = cache.get(cacheKey);
    const t = now().getTime();
    if (hit && t - hit.at < ttl) return hit.value;
    const value = await fn();
    cache.set(cacheKey, { at: t, value });
    return value;
  }

  async function pg(path, { timeoutMs = 8000 } = {}) {
    // Every query eats the same 60s the model calls do (brief §3.4), so each one
    // is bounded. A hung DB read must not be what kills the invocation.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${url}/rest/v1/${path}`, {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
        },
        signal: ac.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new DbError(
          `Supabase ${res.status} on ${path.split("?")[0]}: ${body.slice(0, 200)}`,
          { status: res.status, path }
        );
      }
      return await res.json();
    } catch (e) {
      if (e instanceof DbError) throw e;
      if (e?.name === "AbortError") {
        throw new DbError(`Supabase read timed out after ${timeoutMs}ms on ${path.split("?")[0]}`, { path });
      }
      throw new DbError(`Supabase read failed on ${path.split("?")[0]}: ${e?.message || e}`, { path });
    }
  }

  // ---------------------------------------------------------------------------
  // Aggregates / stockpiles — BT3's get_aggregates shape
  // ---------------------------------------------------------------------------
  async function getAggregates() {
    return cached(`agg:${locationId}`, ttlMs, async () => {
      // The !materials_source_id_fkey hint is REQUIRED, not decoration.
      // materials -> locations is ambiguous to PostgREST: there is the source_id
      // FK (the quarry) AND a many-to-many through location_materials (which
      // plants stock it). Without the hint it returns PGRST201 and no rows.
      const rows = await pg(
        `location_materials?location_id=eq.${locationId}&active=is.true` +
        `&select=active,material:materials(id,aggregate_type,size_desig,spec_size,wash,rock,source_id,source:locations!materials_source_id_fkey(id,name,code))`
      );

      const materials = rows
        .map((r) => r.material)
        .filter(Boolean)
        .map((m) => ({
          id: m.id,
          aggregate_type: m.aggregate_type,
          size_desig: m.size_desig,
          spec_size: m.spec_size,
          wash: m.wash,
          rock: m.rock,
          source_id: m.source_id,
          source_name: m.source?.name ?? null,
          source_code: m.source?.code ?? null,
        }));

      // The plant's own source id — RAP comes from here, not a quarry.
      const plantSourceId = materials.find((m) => m.source_code)?.source_id ?? locationId;
      const { materials: named, collisions } = nameMaterials(materials, { plantSourceId });

      // Latest gradation per material. One query for all of them rather than
      // N round-trips; ordering desc lets us keep the first per material.
      const ids = named.map((m) => m.id);
      const tests = ids.length
        ? await pg(
            `aggregate_gradation_tests?material_id=in.(${ids.join(",")})&voided_at=is.null` +
            `&order=material_id.asc,test_date.desc` +
            `&select=id,material_id,test_date,sampled_at,wash_loss_pct,moisture_pct,comments,` +
            `gradations(id,gradation_results(pct_passing,sieve:sieves(label,opening_mm)))`
          )
        : [];

      const latest = new Map();
      for (const t of tests) if (!latest.has(t.material_id)) latest.set(t.material_id, t);

      const products = named.map((m) => {
        const t = latest.get(m.id);
        const resultRows = (t?.gradations?.[0]?.gradation_results || []).map((g) => ({
          opening_mm: g.sieve?.opening_mm,
          label: g.sieve?.label,
          pct_passing: g.pct_passing,
        }));
        const { gradation_mm, dropped_sieves } = gradationFromRows(resultRows);
        const f = freshness(t?.test_date, now());

        return {
          // BT3 shape, so bailey_calc's blend math needs no changes.
          id: `mat-${m.id}`,
          material_code: null,       // Danville does not populate materials.material_code
          agg_type: m.display_name,  // the DERIVED name, never a bare "#10"
          raw_agg_type: m.aggregate_type,
          producer: m.source_name,
          producer_no: null,
          gsb: null,                 // lives on mix_components, not materials
          plant: "DBT",
          rock: m.rock,
          size_desig: m.size_desig,
          spec_size: m.spec_size,
          wash: m.wash,
          material_id: m.id,         // for plant_rules' allowlist; scrubbed before display
          gradation_mm,
          gradation_status: f.status,
          gradation_age_days: f.age_days,
          gradation_tested_on: f.tested_on,
          wash_loss_pct: t?.wash_loss_pct == null ? null : Number(t.wash_loss_pct),
          moisture_pct: t?.moisture_pct == null ? null : Number(t.moisture_pct),
          dropped_sieves,
          notes: t?.comments ?? null,
        };
      });

      return { plant: "DBT", location_id: locationId, product_count: products.length, products, collisions };
    });
  }

  // ---------------------------------------------------------------------------
  // Designs — BT3's get_design shape
  // ---------------------------------------------------------------------------
  function designName(d) {
    // Danville has seven 0.38D variants, two pairs differing only by a
    // parenthesised plant mix code (brief §3.3). The code is part of the name.
    return d.plant_mix_code ? `${d.mix_type} (${d.plant_mix_code})` : d.mix_type;
  }

  async function listDesigns() {
    return cached(`designs:${locationId}`, ttlMs, async () => {
      const rows = await pg(
        `mix_designs?location_id=eq.${locationId}&active=is.true&order=mix_type.asc` +
        `&select=id,mix_type,plant_mix_code,jmf_number,jmf_id,bid_code,esal_class,effective_date,` +
        `design_gmm,gsb_blend,optimum_ac_pct,design_air_voids,design_vma,rap_total_pct`
      );
      return rows.map((d) => ({ ...d, display_name: designName(d) }));
    });
  }

  async function getDesign(nameOrCode) {
    const designs = await listDesigns();
    const q = String(nameOrCode || "").trim().toLowerCase();
    if (!q) throw new DbError("getDesign needs a mix design name.");

    // Resolution order matters, and an EXACT name match is deliberately NOT
    // treated as decisive. Danville has pairs whose names differ only by a
    // trailing parenthesised plant mix code:
    //
    //   CL3 0.38D 64-22 Fine Surface
    //   CL3 0.38D 64-22 Fine Surface (3038D64F01)
    //
    // The first is an exact match AND a prefix of the second. A tech saying
    // "the 0.38D Fine Surface" almost certainly does not know the code exists,
    // so resolving that to the un-coded variant would silently pick a design on
    // a coin flip -- the exact failure rule 2b exists to prevent, and
    // wrong-design targets corrupt every number computed after them.
    //
    // A plant mix code, by contrast, IS a unique identifier, so it resolves.
    const byCode = designs.filter((d) => String(d.plant_mix_code || "").toLowerCase() === q);
    if (byCode.length === 1) return buildDesign(byCode[0]);

    const hits = designs.filter((d) => d.display_name.toLowerCase().includes(q));

    if (!hits.length) {
      return { found: false, query: nameOrCode, candidates: designs.map((d) => d.display_name) };
    }
    if (hits.length > 1) {
      // Rule 2b: a class alone does not identify a design. Return the ambiguity
      // rather than picking one — wrong-design targets corrupt everything after.
      return {
        found: false,
        ambiguous: true,
        query: nameOrCode,
        candidates: hits.map((d) => d.display_name),
      };
    }

    return buildDesign(hits[0]);
  }

  async function buildDesign(d) {
    const [components, targets] = await Promise.all([
      pg(`mix_components?mix_design_id=eq.${d.id}&order=percentage.desc` +
         `&select=component_name,material_code,percentage,gsb,producer,material_id`),
      pg(`mix_design_targets?mix_design_id=eq.${d.id}` +
         `&select=target_pct,tol_low,tol_high,sieve:sieves(label,opening_mm)`),
    ]);

    const targetRows = targets.map((t) => ({
      opening_mm: t.sieve?.opening_mm,
      label: t.sieve?.label,
      pct_passing: t.target_pct,
    }));
    const { gradation_mm, dropped_sieves } = gradationFromRows(targetRows);

    const tolerances = {};
    for (const t of targets) {
      const k = sieveKeyFromMm(t.sieve?.opening_mm);
      if (k === null) continue;
      tolerances[k] = {
        low: t.tol_low == null ? null : Number(t.tol_low),
        high: t.tol_high == null ? null : Number(t.tol_high),
      };
    }

    return {
      found: true,
      // BT3 shape
      design_name: d.display_name,
      mix_type: d.mix_type,
      plant_mix_code: d.plant_mix_code,
      bid_code: d.bid_code,
      esal_class: d.esal_class,
      effective_date: d.effective_date,
      plant: "DBT",
      // mix_components is the recipe in SPEC-SIZE vocabulary. Its component_name
      // is a size (sometimes with a source prefix: CC = Caldwell Stone,
      // G = Gaddie Shamrock), NOT a yard product, and material_id is currently
      // unpopulated at Danville. Do not resolve these to materials here — see
      // CLAUDE.md. Carried through as-is so the recipe can be shown.
      aggregates: components.map((c) => ({
        agg_type: c.component_name,
        percent: c.percentage == null ? null : Number(c.percentage),
        gsb: c.gsb == null ? null : Number(c.gsb),
        producer: c.producer ?? null,
        material_code: c.material_code ?? null,
        material_id: c.material_id ?? null,
        resolved: c.material_id != null,
      })),
      components_resolved: components.every((c) => c.material_id != null),
      jmf_gradation_mm: gradation_mm,
      tolerances,
      dropped_sieves,
      recycle: {
        rap_total_pct: d.rap_total_pct == null ? null : Number(d.rap_total_pct),
        total_ac_in_mix_pct: null,
      },
      design_volumetrics: {
        // Trap §2.7: AC = 0 means "not recorded", not zero. Treated literally it
        // produced a false remove/replace flag at BT3. Same question here.
        optimum_ac_pct: nullIfZero(d.optimum_ac_pct),
        air_voids_pct: d.design_air_voids == null ? null : Number(d.design_air_voids),
        vma_pct: d.design_vma == null ? null : Number(d.design_vma),
        gmm: d.design_gmm == null ? null : Number(d.design_gmm),
        gsb_blend: d.gsb_blend == null ? null : Number(d.gsb_blend),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Samples — replaces BT3's query_dataverse stub, which never shipped
  // ---------------------------------------------------------------------------
  async function getSamples({ design = null, lot = null, limit = 10 } = {}) {
    const n = Math.max(1, Math.min(50, Number(limit) || 10));
    let path =
      `volumetric_tests?location_id=eq.${locationId}&voided_at=is.null` +
      `&order=sampled_at.desc&limit=${n}` +
      `&select=id,mix_design_id,lot_number,sublot_number,sampled_at,ac_percent,total_tons,` +
      `daily_tons,temperature_f,notes,work_type,` +
      `design:mix_designs(mix_type,plant_mix_code),` +
      `bins:test_bin_percentages(bin_number,percentage,material:materials(id,aggregate_type,size_desig,wash,rock,source_id,source:locations!materials_source_id_fkey(name,code))),` +
      `gradations(kind,ignition_oven_ac,extraction_ac,gradation_results(pct_passing,sieve:sieves(label,opening_mm)))`;
    if (lot != null) path += `&lot_number=eq.${Number(lot)}`;

    const rows = await pg(path);
    const filtered = design
      ? rows.filter((r) => {
          const nm = r.design?.plant_mix_code
            ? `${r.design.mix_type} (${r.design.plant_mix_code})`
            : r.design?.mix_type || "";
          return nm.toLowerCase().includes(String(design).toLowerCase());
        })
      : rows;

    return {
      plant: "DBT",
      location_id: locationId,
      sample_count: filtered.length,
      samples: filtered.map((r) => {
        const mats = (r.bins || []).map((b) => b.material).filter(Boolean);
        const plantSourceId = mats.find((m) => m.source?.code)?.source_id ?? locationId;
        const gradRows = (r.gradations?.[0]?.gradation_results || []).map((g) => ({
          opening_mm: g.sieve?.opening_mm,
          label: g.sieve?.label,
          pct_passing: g.pct_passing,
        }));
        const { gradation_mm, dropped_sieves } = gradationFromRows(gradRows);

        return {
          design_name: r.design?.plant_mix_code
            ? `${r.design.mix_type} (${r.design.plant_mix_code})`
            : r.design?.mix_type ?? null,
          lot: r.lot_number,
          sublot: r.sublot_number,
          sampled_at: r.sampled_at,
          work_type: r.work_type ?? null,
          ac_pct: nullIfZero(r.ac_percent),
          total_tons: r.total_tons == null ? null : Number(r.total_tons),
          daily_tons: r.daily_tons == null ? null : Number(r.daily_tons),
          temperature_f: r.temperature_f ?? null,
          ignition_oven_ac: nullIfZero(r.gradations?.[0]?.ignition_oven_ac),
          extraction_ac: nullIfZero(r.gradations?.[0]?.extraction_ac),
          // These bins DO carry material_id (44/44 rows at Danville), which is
          // what plant_rules' polish-resistant allowlist needs. This is the
          // path that works today.
          bins: (r.bins || [])
            .slice()
            .sort((a, b) => (a.bin_number ?? 0) - (b.bin_number ?? 0))
            .map((b) => ({
              bin: b.bin_number,
              agg_type: b.material
                ? materialDisplayName(
                    {
                      aggregate_type: b.material.aggregate_type,
                      size_desig: b.material.size_desig,
                      wash: b.material.wash,
                      source_id: b.material.source_id,
                      source_name: b.material.source?.name,
                    },
                    { plantSourceId }
                  )
                : null,
              percent: b.percentage == null ? null : Number(b.percentage),
              material_id: b.material?.id ?? null,
              rock: b.material?.rock ?? null,
            })),
          gradation_mm,
          dropped_sieves,
          // Rule 10b: free text written by a human at a plant, flowing straight
          // into model context. Evidence, never instructions. Tagged so the
          // serialization boundary can fence it.
          notes: r.notes ?? null,
          notes_are_untrusted_free_text: r.notes ? true : false,
        };
      }),
    };
  }

  return {
    locationId,
    getAggregates,
    listDesigns,
    getDesign,
    getSamples,
    _pg: pg,
    _clearCache: () => cache.clear(),
  };
}

/** Trap §2.7: a recorded 0 for AC means "not recorded". */
export function nullIfZero(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return null;
  return n;
}
