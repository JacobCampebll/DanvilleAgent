// The system prompt is the one string the model actually reads about itself.
// Offline, no network.
//
// Why this exists: step 4's notes claimed "doctrine re-pointed". It was not.
// The prompt still opened "You are the Boonesboro Lab Agent — ... Boonesborough
// Asphalt Plant (plant folder BT3)", so the deployed Danville agent introduced
// itself to Danville's techs as another plant's assistant, cited another plant's
// designs (CL3 0.38A 64-22 Coarse Haydon), and referenced another plant's
// material codes (BBQ10W). Twelve distinct plant-specific errors survived a port
// that every other test passed — because no test read this string.
//
// Nothing here checks prose quality. These pin the FACTS a wrong answer would
// be built on.
//
//   node tests/system_prompt.test.mjs
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log("ok:", label); }
  else { fail++; console.log("FAIL:", label); }
}

const src = readFileSync(new URL("../netlify/functions/agent.mjs", import.meta.url), "utf8");

function block(name) {
  const i = src.indexOf(`const ${name} = \``);
  if (i < 0) return "";
  return src.slice(i, src.indexOf("`;", i));
}
const prompt = block("SYSTEM_PROMPT");
const grok   = block("GROK_SUPPLEMENT");

assert(prompt.length > 5000, `SYSTEM_PROMPT found and substantial (${prompt.length} chars)`);

// --- identity ---------------------------------------------------------------
assert(/Danville Lab Agent/.test(prompt), "introduces itself as the Danville Lab Agent");
assert(/Danville Asphalt Plant/.test(prompt), "names Danville Asphalt Plant");
assert(/\bDBT\b/.test(prompt), "carries the DBT plant folder");

// The model must never be told it is BT3. Rule 3 legitimately explains WHY the
// Boonesborough contracts corpus is not loaded, so one mention is allowed there
// and nowhere else.
for (const [where, text] of [["SYSTEM_PROMPT", prompt], ["GROK_SUPPLEMENT", grok]]) {
  const hits = text.split("\n").filter((l) => /Boonesbor|BT3/.test(l));
  const allowed = hits.filter((l) => /no contracts tool/.test(l));
  assert(hits.length === allowed.length,
    `${where}: every BT3/Boonesborough mention is the contracts-corpus explanation (stray: ${hits.length - allowed.length})`);
  assert(!/You are the Boonesboro/.test(text), `${where}: does not claim to be Boonesborough's agent`);
}

// --- the tool count in the prose must match the tools actually offered ------
// "eight tools" outlived search_contracts being dropped. A model told it has a
// tool it does not have will narrate using it.
const toolsBlock = src.slice(src.indexOf("const TOOLS"), src.indexOf("\n];", src.indexOf("const TOOLS")));
const toolNames = [...toolsBlock.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]);
const WORDS = { 5:"five", 6:"six", 7:"seven", 8:"eight", 9:"nine" };
assert(toolNames.length === 7, `7 tools are offered (got ${toolNames.length}: ${toolNames.join(", ")})`);
assert(prompt.includes(`${WORDS[toolNames.length]} tools`),
  `the prompt says "${WORDS[toolNames.length]} tools", matching what is offered`);

// every tool the prompt advertises must exist, and vice versa
for (const t of toolNames)
  assert(prompt.includes(t), `offered tool "${t}" is described in the prompt`);
assert(!/\bsearch_contracts\b/.test(prompt), "the prompt does not advertise the dropped search_contracts");

// --- no other plant's data in ANY model-visible string ----------------------
// The first pass of this audit grepped only for "Boonesbor|BT3" and reported
// GROK_SUPPLEMENT clean. It was not: it carried [Mix: CL3 0.38A 64-22 Coarse
// Haydon] and a [CID …] citation, neither of which contains either word — and
// grok is the DEFAULT provider, so that was the copy most answers ran on. So
// check every string the model can see, against names rather than just brands.
const MODEL_VISIBLE = [["SYSTEM_PROMPT", prompt], ["GROK_SUPPLEMENT", grok]];

// Known Boonesborough design names. An explicit denylist rather than parsing
// names out of the prose: the first version of this check used a lazy regex
// that stopped at the "." in "0.38A", compared the fragment "CL3 0", and passed
// on BT3's name. Same failure as the backwards slice in frontend_contract —
// an extraction that silently matches nothing grades nothing.
const BT3_DESIGNS = [
  "Coarse Haydon", "with 11's", "with 11s", "0.38B 64-22 with",
  "Gaddie 00260116", "00260175",
];
// And the names that SHOULD be there, so the checks cannot pass vacuously on a
// prompt that mentions no design at all.
const DANVILLE_DESIGNS = ["CL3 0.38A 64-22 Surface", "CL3 0.38D 64-22 Fine Surface"];

for (const [where, text] of MODEL_VISIBLE) {
  for (const n of BT3_DESIGNS)
    assert(!text.includes(n), `${where}: no Boonesborough design name — "${n}"`);
  assert(DANVILLE_DESIGNS.some((d) => text.includes(d)),
    `${where}: names at least one real Danville design (so the check above is not vacuous)`);
  assert(!/BBQ\d/.test(text), `${where}: no Boonesborough material codes (BBQ…)`);
  assert(!/\[CID /.test(text), `${where}: no [CID …] citation format — no contracts tool to cite`);
  assert(!/8-digit/.test(text), `${where}: no "8-digit" id language (Danville ids are 1-2 digits)`);
}

// --- ids: Danville's are small integers -------------------------------------
// "never surface the 8-digit JMF number" protects nothing here: mix_designs.id
// runs 48-96 and material ids are 1-2 digits.
assert(/never write one|NEVER surface a raw database id/i.test(prompt),
  "still forbids writing a raw id, in terms that apply to Danville");

// --- the two Danville-shaped facts the doctrine depends on ------------------
assert(/SEVEN 0\.38D|seven 0\.38D/i.test(prompt), "fingerprint rule states the real 0.38D count");
assert(/resolved:false|NOT resolved to stockpiles/i.test(prompt),
  "get_design's description says components are not resolved to stockpiles");
assert(/no contracts tool/i.test(prompt), "states plainly that there is no contracts tool");

// --- the prompt must not tell the model to do what it cannot ---------------
assert(!/check the contract's SPs/i.test(prompt),
  "does not instruct a contract-SP lookup it has no tool for");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
