/**
 * Stage 2 of the TheMealDB import: map its 738 ingredient names onto our own
 * catalogue, replacing the USDA text-search resolution.
 *
 * WHY THIS EXISTS. The old path (tools/themealdb_nutrition/resolve_usda.py)
 * matched ingredient names against USDA FoodData Central by text search, and
 * that search matched on shared words with no sanity check. Measured 2026-09-05:
 *
 *     garlic         -> "Garlic sauce"                  683 kcal, 74.0 g fat
 *     cold water     -> "Oil, flaxseed, cold pressed"   884 kcal, 100  g fat
 *     clear honey    -> "Oil, industrial, soy"          884 kcal, 100  g fat
 *     cinnamon stick -> "Butter, stick"                 743 kcal, 82.2 g fat
 *     palm sugar     -> "Oil, palm"                     884 kcal, 100  g fat
 *
 * Garlic and water appear in a large share of 472 recipes, so those are not
 * edge cases, they contaminate the totals. We now hold 3,741 lab-analysed
 * AUSNUT generics with complete 19-nutrient coverage, which is both better data
 * and Australian. Resolving against our own catalogue also populates
 * recipe_ingredients.food_id, the mapping-completeness gate the schema was
 * designed around, so it fixes the numbers and the foreign keys in one pass.
 *
 * Matched against food_type = 'generic' ONLY. A recipe ingredient is a generic
 * food; matching "onion" to a branded Open Food Facts onion product would be
 * semantically wrong even when the nutrition happened to be close.
 *
 * Read-only. Writes a JSON map for stage 3, never touches the database.
 *
 *   node importers/themealdb/resolve.js
 *   node importers/themealdb/resolve.js --verbose   (print every decision)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';

import { ENV } from '../../src/config/env.js';

const VERBOSE = process.argv.includes('--verbose');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const IN = path.resolve(HERE, '../../../tools/themealdb_extract/out/themealdb.json');
const OUT_DIR = path.resolve(HERE, 'out');

/**
 * TheMealDB ingredient names carry preparation state that AUSNUT expresses as
 * separate name segments: "Freshly chopped parsley", "Cubed Feta cheese",
 * "Minced garlic". Stripping these leaves the core food noun, which is what
 * AUSNUT's base_name actually holds. Order matters: multi-word phrases first.
 */
const PREP_WORDS = [
  'freshly chopped', 'finely chopped', 'roughly chopped', 'thinly sliced',
  'free range', 'free-range', 'ready made', 'ready-made',
  'chopped', 'minced', 'sliced', 'diced', 'grated', 'shredded', 'crushed',
  'cubed', 'mashed', 'peeled', 'trimmed', 'boneless', 'skinless', 'beaten',
  'melted', 'softened', 'chilled', 'frozen', 'canned', 'tinned',
  'fresh', 'freshly', 'finely', 'roughly', 'thinly', 'coarsely', 'whole',
  'plain', 'large', 'medium', 'small', 'baby', 'organic',
  'toasted', 'lean', 'boiling', 'iced', 'pitted', 'stoned', 'deseeded',
  'shelled', 'halved', 'quartered', 'crumbled', 'jumbo', 'silken', 'fine',
  'hot', 'cold', 'warm', 'clear', 'pure', 'extra', 'virgin', 'ready',
];

// NOT stripped, deliberately. Each of these changes the food materially, so
// removing them invites the exact error class this file exists to avoid:
// dropping "unsweetened" matched coconut milk to the CONDENSED SWEETENED row,
// and dropping "dried" would match dried cherries to raw cherries at roughly
// six times the water content. If the catalogue has no unsweetened variant,
// the right outcome is no match and a human decision, not a confident wrong one.
// Each entry is [claim, what SATISFIES it in a catalogue name]. The alternatives
// matter: AUSNUT writes "Butter, plain, no added salt", never "unsalted", so a
// literal word test rejected the one correct row for 19 uses and left the
// WRONG one ("Butter, plain, salted") as the best guess.
//
// 'ground' and 'roasted' were deliberately REMOVED from this list after review.
// Ground almonds and whole almonds are nutritionally identical, so treating
// "ground" as a claim blocked good matches for no benefit. The words kept here
// all change water, sugar, sodium or fat materially.
const MEANINGFUL_WORDS = [
  ['unsweetened', /\b(unsweetened|no added sugar|without added sugar)\b/],
  ['sweetened', /\b(sweetened|added sugar|in syrup)\b/],
  ['unsalted', /\b(unsalted|no added salt|without added salt|salt reduced)\b/],
  ['salted', /\bsalted\b/],
  ['dried', /\b(dried|dehydrated|dry)\b/],
  ['smoked', /\bsmoked\b/],
  ['raw', /\b(raw|natural|fresh)\b/],
  ['cooked', /\b(cooked|boiled|baked|roasted|grilled|fried|prepared)\b/],
  ['seasoned', /\bseasoned\b/],
  ['reduced', /\b(reduced|light|lite|low)\b/],
];

/**
 * TheMealDB is a British/American recipe site; AUSNUT is an Australian survey
 * table. Measured 2026-09-05, this vocabulary gap was the single largest cause
 * of NO MATCH, and every one of these foods IS in the catalogue under its
 * Australian name: cornstarch (25 uses), greek yogurt (14), aubergine (10),
 * scallions (9), cilantro. So these are synonyms, not missing data.
 *
 * This is what catalog_foods.food_aliases is for, and seeding that table from
 * this list is the proper long-term home. Keeping it here for now means the
 * resolver stays runnable without a migration.
 */
const SYNONYMS = new Map(Object.entries({
  aubergine: 'eggplant',
  courgette: 'zucchini',
  cilantro: 'coriander',
  scallion: 'spring onion',
  cornstarch: 'cornflour',
  'corn starch': 'cornflour',
  yogurt: 'yoghurt',
  arugula: 'rocket',
  'bell pepper': 'capsicum',
  shrimp: 'prawn',
  'ground beef': 'beef mince',
  'minced beef': 'beef mince',
  'all purpose flour': 'plain flour',
  'heavy cream': 'cream',
  'double cream': 'cream',
  'single cream': 'cream',
  'confectioners sugar': 'icing sugar',
  'powdered sugar': 'icing sugar',
  garbanzo: 'chickpea',
  rutabaga: 'swede',
  beet: 'beetroot',
  mangetout: 'snow pea',
  'golden raisin': 'sultana',
  'baking soda': 'bicarbonate soda',
  'bicarbonate of soda': 'bicarbonate soda',
  'spring onions': 'spring onion',
  coriander: 'coriander',

  // Substitutions onto a food AUSNUT actually holds, each checked by query on
  // 2026-09-06 rather than assumed. AUSNUT is a survey table of foods as eaten,
  // not an ingredient encyclopedia, so it has no brisket, haddock, peppercorn or
  // fettuccine row at all. Aliasing to a nutritionally close food keeps the
  // numbers coming from lab-measured AUSNUT data, which is far safer than me
  // typing per-100 g values from memory.
  challot: 'shallot',                       // misspelt in the source data
  peppercorn: 'pepper black',               // -> Pepper, black or white, ground
  haddock: 'fish white flesh',              // -> Fish, white flesh, raw
  cod: 'fish white flesh',
  pollock: 'fish white flesh',
  clam: 'mussel',                           // both lean shellfish
  'lasagne sheet': 'pasta uncooked',
  fettuccine: 'pasta uncooked',
  tagliatelle: 'pasta uncooked',
  linguine: 'pasta uncooked',
  'creme fraiche': 'cream sour',            // ~30% vs ~20% fat, closest AUSNUT holds

  // ---------------------------------------------------------------------
  // AUSNUT-FIRST PASS, added 2026-09-08. Every target below was verified
  // present in catalog_foods by DIRECT QUERY before being written here.
  //
  // The lesson that produced this block: the 22/22 search ranking is not a
  // presence test. Its `<%` trigram shortlist reported "no AUSNUT row" for
  // foods AUSNUT plainly holds - `lemongrass` needs "lemon grass",
  // `allspice` was matching "Licorice, allsorts", `passata` was never
  // compared against "Tomato, puree, commercial" at all. A plain ILIKE found
  // all of them instantly. Before declaring a food absent from a source,
  // probe with substring matching, not just trigram.
  //
  // Measured effect of this block alone, no new data source: ingredient mass
  // coverage 97.13% -> 98.91%, and recipes at 100% mass coverage 334 -> 444
  // of 472. See claude_memory/database redesign/test results/scripts/
  // usda_gapfill_analysis/ for the probes and captured output.
  //
  // Several targets carry EXTRA words purely to pin the right row, because
  // the derivation tiebreak otherwise picks a wrong variant: plain 'beer'
  // ranks "Beer, de-alcoholised" (label_data) above "Beer, not further
  // defined" (recipe), plain 'liqueur' picks the cream-based row, plain
  // 'currant' picks "Currant, dried" (~6x concentrated) over "Currant,
  // fresh", and plain 'fish white flesh' picks the crumbed-and-cooked row
  // over the raw one. Do not "simplify" these targets.

  // AU vs UK/US vocabulary, same food.
  passata: 'tomato puree',                  // -> Tomato, puree, commercial
  'tomato ketchup': 'sauce tomato commercial',
  ketchup: 'sauce tomato',                  // AU "tomato sauce" IS ketchup
  sweetcorn: 'corn',                        // -> Corn, raw
  'petit poi': 'pea green',                 // normalised form of "petit pois"
  zest: 'peel',                             // lemon zest -> Lemon peel, raw
  'pak choi': 'bok choy',
  'pak koi': 'bok choy',                    // "baby pak koi", baby is stripped
  'bok choi': 'bok choy',
  kielbasa: 'kabana cabanossi',             // same smoked sausage family
  'polish kabano': 'kabana cabanossi',
  'jamon iberico': 'ham leg lean',          // needs the deaccent step below
  'bacon lardon': 'bacon middle rasher no fat removed',
  'sirloin steak tip': 'beef sirloin steak lean',
  'pork tenderloin': 'pork steak medallion loin lean',
  gruyere: 'cheese swiss',                  // -> Cheese, swiss or jarlsberg
  'parmigiano reggiano': 'cheese parmesan',
  hazlenut: 'hazelnut',                     // source misspelling
  redcurrant: 'currant fresh',              // NOT "Currant, dried"
  cacao: 'cocoa powder',
  pilchard: 'sardine canned',
  monkfish: 'fish white flesh raw',
  'sea bass': 'fish white flesh raw',
  penne: 'pasta uncooked',
  'penne rigate': 'pasta uncooked',
  farfalle: 'pasta uncooked',
  rigatoni: 'pasta uncooked',
  'rice vermicelli': 'noodle rice stick',
  'egg wash': 'egg chicken whole raw',
  'meringue nest': 'meringue commercial',
  lard: 'fat solid animal',
  stout: 'beer not further defined',
  brandy: 'spirit',                         // -> Spirit, all types
  'grand marnier': 'liqueur non cream',

  // Chillies. AUSNUT has one generic chilli plus a dried/ground row; the
  // cultivar names are not in any composition table and are nutritionally
  // interchangeable at the gram quantities recipes use them in.
  'scotch bonnet': 'chilli red',
  'bird eye chilly': 'chilli red',          // normalised "birds-eye chillies"
  jalapeno: 'chilli',
  'ancho chilly': 'chilli dried ground',
  'dried red chilly': 'chilli dried ground',
  'dried chilly': 'chilli dried ground',
  'pul biber': 'chilli dried ground',
  'ground cardomom': 'cardamom seed dried ground',

  // Paprika and chilli powders, fixed 2026-09-09. These were matching badly
  // and had been for some time, all found by probing AUSNUT with ILIKE:
  //   paprika (39 uses)      -> "Spices, dried, all types (EXCEPT CHILLI &
  //                             PAPRIKA)" - the row's own name excludes it.
  //   cayenne pepper (14)    -> "Pepper, stuffed, marinated", a capsicum dish,
  //                             at HIGH confidence.
  //   chilli powder (11)     -> "Cocoa powder".
  // AUSNUT does hold "Paprika, dried, ground"; cayenne and chilli powder are
  // both ground dried chilli, which it also holds.
  //
  // The smoked variants deliberately drop the word "smoked" via substitution
  // rather than tripping the MEANINGFUL_WORDS guard. Smoke-DRYING paprika does
  // not materially change its macros the way smoking a salmon does (which adds
  // salt and removes water), so treating it as a claim would demote 9 uses to
  // no answer for no nutritional gain. This is a judgement, recorded on purpose.
  paprika: 'paprika dried ground',
  'smoked paprika': 'paprika dried ground',
  'sweet smoked paprika': 'paprika dried ground',
  'smoky paprika': 'paprika dried ground',
  'cayenne pepper': 'chilli dried ground',
  cayenne: 'chilli dried ground',
  'chilli powder': 'chilli dried ground',
  'chili powder': 'chilli dried ground',

  // The spice tail. AUSNUT ships a deliberate generic row, "Spices, dried,
  // all types (except chilli & paprika)", and spices enter recipes in gram
  // quantities, so this is the RIGHT level of precision rather than a
  // compromise. Keys are the normalised forms; 'ground' is not a PREP_WORD
  // so "ground allspice" needs its own entry or containment fails on it.
  allspice: 'spices dried',
  'ground allspice': 'spices dried',
  'ground annatto': 'spices dried',
  saffron: 'spices dried',
  'star anise': 'spices dried',
  'garam masala': 'spices dried',
  'ras el hanout': 'spices dried',
  sumac: 'spices dried',
  cajun: 'spices dried',

  // Judgement calls. Defensible, but a human should sign these off; they are
  // listed in out/gap_resolution.json under alias_judgement with reasons.
  suet: 'fat solid animal',                 // hard beef fat; no AUSNUT suet row
  pecorino: 'cheese parmesan',              // hard sheep cheese
  manchego: 'cheese swiss',
  sevaiiya: 'pasta uncooked',               // wheat vermicelli, not the soy kind
  malai: 'cream thickened',
  'smoky aioli': 'mayonnaise',              // aioli is garlic mayonnaise
  'dulce de leche': 'milk condensed sweetened',
}));

/**
 * Deliberately NOT aliased, recorded so the next person does not "fix" it:
 *   beef brisket -> brisket is far fattier than the rump/sirloin rows AUSNUT
 *                   has; a lean-cut substitution would understate it badly.
 *   beef shin    -> same reasoning; collagen-rich braising cut, not steak.
 *   oxtail       -> no AUSNUT row and no lean-cut substitute that is honest.
 *   lemongrass   -> AUSNUT has no lemon grass row at all (checked by ILIKE,
 *                   not just trigram). USDA SR Legacy has one.
 *   mulukhiyah   -> AUSNUT has no jute/mulukhiyah row. USDA does.
 *   orange zest  -> AUSNUT has "Lemon peel, raw" but no orange peel row.
 *   These six are the entire remaining USDA gap-fill case, ~5,027 g of
 *   ingredient mass (0.70%). See project memory for the deferral decision.
 *
 *   callaloo, ackee, knafeh, freekeh, mincemeat, galangal, gochujang,
 *   doubanjiang, ciabatta, rice krispies, food colouring -> absent from BOTH
 *   AUSNUT and USDA. These stay unmatched behind a recipe coverage flag,
 *   which is the honest outcome: 0.38% of mass, materially affecting only
 *   Callaloo and SaltFish, Mince Pies, Mutabbaq, Saltfish and Ackee, Knafeh.
 *
 *   hotsauce -> a hot sauce is mostly water; aliasing it to ground chilli
 *   would overstate it by an order of magnitude. Left unmatched on purpose.
 *
 * SUPERSEDED 2026-09-08: this block previously listed passata, sweetcorn,
 * saffron, scotch bonnet, dulce de leche, suet, garam masala, star anise and
 * tomato ketchup as "genuinely absent, no close relative". That was wrong.
 * Every one of them IS in AUSNUT; the trigram shortlist simply never surfaced
 * the row. They are aliased above now, each verified by direct query.
 */

/**
 * English plurals, done properly enough for food nouns. The naive
 * "drop a trailing s" produced "potatoe" from "potatoes" and "chillie" from
 * "chillies", which is why `potatoes` (50 uses) and `tomatoes` (17) were
 * failing containment against perfectly good catalogue rows.
 */
// -ves -> -f applies only to real f/fe stems. Applying it by suffix turned
// "cloves" into "clof", which is why `cloves` (8 uses) never matched
// "Cloves, dried, ground". Found by reading the review queue, not by testing.
const VES_WORDS = new Set(['leaves', 'loaves', 'knives', 'halves', 'shelves',
  'calves', 'hooves', 'thieves', 'wolves']);

const singular = (w) => {
  if (w.length <= 3) return w;
  if (w.endsWith('oes')) return w.slice(0, -2);        // potatoes -> potato
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`;  // berries  -> berry
  if (VES_WORDS.has(w)) return `${w.slice(0, -3)}f`;   // leaves   -> leaf
  if (w.endsWith('ses') || w.endsWith('ches') || w.endsWith('shes')) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
};

/**
 * English -ies has two stems and there is no way to pick correctly from the
 * word alone: berries -> berry, but chillies -> chilli. So generate BOTH and
 * let containment succeed on either. Measured cost of getting this wrong:
 * strawberries, raspberries and blackberries are ~4 kg of ingredient mass whose
 * correct catalogue row was sitting at rank 1 the whole time.
 */
const variants = (w) => {
  const out = new Set([w, singular(w)]);
  if (w.endsWith('ies')) { out.add(`${w.slice(0, -3)}i`); out.add(`${w.slice(0, -3)}y`); }
  return out;
};

/**
 * Words that name a UNIT rather than a food. "garlic clove" is garlic measured
 * in cloves, not a clove; leaving it in sent the backoff to "clove" and matched
 * "Cloves, dried, ground", the spice, for 49 uses. Stripped only when other
 * words remain, so a bare "cloves" still resolves to the spice correctly.
 */
const UNIT_WORDS = ['clove', 'sprig', 'leaf', 'stick', 'head', 'bunch', 'pod',
  'stalk', 'rasher', 'fillet', 'slice', 'piece', 'knob', 'dash', 'pinch',
  'handful', 'chunk', 'strip', 'wedge', 'segment', 'sheet', 'bulb'];

const normalise = (raw) => {
  // Fold diacritics FIRST. The a-z filter below turns every accented letter
  // into a space, which shredded "gruyere" -> "gruy re", "jamon iberico"
  // -> "jam n ib rico" and "aioli" -> "a oli", so those terms could never
  // match anything and never even reached the synonym map.
  let s = String(raw || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  for (const w of PREP_WORDS) s = s.replace(new RegExp(`\\b${w}\\b`, 'g'), ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.split(' ').map(singular).join(' ').replace(/\s+/g, ' ').trim();
  const parts = s.split(' ').filter(Boolean);
  if (parts.length > 1) {
    const kept = parts.filter((w) => !UNIT_WORDS.includes(w));
    if (kept.length) s = kept.join(' ');
  }
  // Synonyms are applied AFTER singularisation so "scallions" -> "scallion"
  // -> "spring onion" works in one pass. Longest phrases first so
  // "bell pepper" wins over a bare "pepper".
  for (const [from, to] of [...SYNONYMS].sort((a, b) => b[0].length - a[0].length)) {
    s = s.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
  }
  return s.replace(/\s+/g, ' ').trim();
};

const pool = new Pool({ connectionString: ENV.DB_URL });
const db = drizzle(pool);
const all = async (q) => (await db.execute(q)).rows;

/**
 * Same ranking that scored 22/22 in the search experiment: word-set containment
 * first, then source_derivation quality, then exact head noun. Restricted to
 * generic foods, and using the indexed <% operator rather than the function
 * form (measured 27.7 ms vs 172.8 ms).
 */
const WORDS = (col) => sql`(select array_agg(w) from unnest(
  regexp_split_to_array(lower(${sql.raw(col)}), '[^a-z0-9]+')) w where w <> '')`;

const match = async (term) => all(sql`
  select f.id, f.public_id, f.name, f.base_name, p.source_derivation as derivation,
         word_similarity(${term}, f.normalized_name) as wsim
  from catalog_foods f
  join catalog_food_servings s on s.food_id = f.id and s.is_default
  join nutrition_profiles p on p.id = s.nutrition_profile_id
  where f.is_active and f.food_type = 'generic'
    and (${term} <% f.normalized_name)
  order by word_similarity(${term}, f.normalized_name) desc, length(f.name)
  limit 15`);

/**
 * Containment is tested in JS, not SQL, so BOTH sides can be stemmed. The
 * catalogue keeps its own plural forms ("Cloves, dried, ground", "Chives,
 * fresh, raw", "Strawberry, raw"), so comparing raw word strings failed for
 * every plural ingredient even when the row was exactly right: `cloves`,
 * `chives`, `strawberries`, `raspberries`, `blackberries` all had the correct
 * food sitting at rank 1 and were still classified as fuzzy-only.
 */
const wordsOf = (s2) => String(s2 || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const stems = (s2) => {
  const out = new Set();
  for (const w of wordsOf(s2)) for (const v of variants(w)) out.add(v);
  return out;
};

const DERIV_RANK = { analysed: 1, label_data: 2, recipe: 3, imputed: 4, borrowed: 5, estimated: 6 };

const rank = (rows, term) => {
  const qWords = wordsOf(term);
  return rows.map((r) => {
    const nameStems = stems(r.name);
    return {
      ...r,
      covered: qWords.length > 0
        && qWords.every((w) => [...variants(w)].some((v) => nameStems.has(v))),
      base_exact: String(r.base_name || '').toLowerCase() === term,
    };
  }).sort((x, y) => (y.covered - x.covered)
    || ((DERIV_RANK[x.derivation] ?? 7) - (DERIV_RANK[y.derivation] ?? 7))
    || (y.base_exact - x.base_exact)
    || (Number(y.wsim) - Number(x.wsim))
    || (String(x.name).length - String(y.name).length));
};


/**
 * Confidence is about how the match was reached, not a similarity number, so a
 * human reviewing the low tier knows what to look at.
 *   high   - the query words are all present AND the head noun matches exactly
 *   medium - all query words present, but the head noun differs
 *   low    - fuzzy only; the ingredient words are not all in the food name
 */
const confidenceOf = (r) => {
  if (!r) return 'none';
  if (r.covered && r.base_exact) return 'high';
  if (r.covered) return 'medium';
  return 'low';
};

try {
  const payload = JSON.parse(readFileSync(IN, 'utf-8'));
  const names = new Map();
  for (const rec of payload.recipes) {
    for (const ing of rec.ingredients) {
      const key = ing.name.trim().toLowerCase();
      names.set(key, (names.get(key) ?? 0) + 1);
    }
  }
  const ordered = [...names.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`Resolving ${ordered.length} distinct TheMealDB ingredients against`);
  console.log('catalog_foods where food_type = \'generic\' (3,741 AUSNUT rows).\n');

  const map = {};
  const tally = { high: 0, medium: 0, low: 0, none: 0 };

  for (const [name, uses] of ordered) {
    const term = normalise(name);
    // Progressive backoff toward the head noun: "dried white navy beans" ->
    // "white navy bean" -> "navy bean" -> "bean". AUSNUT is an Australian
    // survey table, so specialty items often exist only as their base food.
    // Only a COVERED match is accepted at any step, so backoff cannot invent a
    // fuzzy wrong answer; it either finds a real broader food or gives up.
    const words = term.split(' ').filter(Boolean);
    let best = null;
    let rows = [];
    let usedTerm = term;
    let backedOff = false;
    for (let start = 0; start < Math.max(words.length, 1); start += 1) {
      const attempt = words.slice(start).join(' ');
      if (!attempt) break;
      const found = rank(await match(attempt), attempt);
      if (start === 0) { rows = found; best = found[0]; }
      if (found[0]?.covered) {
        rows = found; best = found[0]; usedTerm = attempt; backedOff = start > 0;
        break;
      }
    }

    // Guard: if the ingredient name makes a claim that materially changes the
    // food, the matched food must honour it. Crucially this now SCANS THE
    // RUNNERS-UP rather than only rejecting the top hit, because the correct
    // row is very often sitting at rank 2: "unsalted butter" had
    // "Butter, plain, salted" at rank 1 and "Butter, plain, no added salt"
    // at rank 2, and the old code kept the wrong one as the best guess.
    // BUG FIXED 2026-09-08: this line had `\b` where lines above use
    // `\\b`. Inside a template literal `\b` is the BACKSPACE character,
    // not a word boundary, so every claim regex was /<backspace>word<backspace>/,
    // `claims` was ALWAYS empty and this entire guard was dead code. It failed
    // silently and invisibly: `contradicted` was set 0 times across all 738
    // ingredients. Live effect at the time of the fix was 38 ingredient uses
    // matched to a contradicting food, headed by `unsalted butter` (19 uses)
    // resolving to "Butter, plain, salted" at HIGH confidence.
    const claims = MEANINGFUL_WORDS.filter(([w]) => new RegExp(`\\b${w}\\b`).test(term));
    const honours = (row) => row && claims.every(([, re_]) => re_.test(String(row.name).toLowerCase()));
    if (claims.length && !honours(best)) {
      const better = rows.find((r) => r.covered && honours(r));
      if (better) {
        best = better;
      } else {
        best = { ...best, covered: false, base_exact: false,
                 contradicted: claims.map(([w]) => w) };
      }
    }

    const conf = confidenceOf(best);
    tally[conf] += 1;
    map[name] = best ? {
      uses,
      normalised: term,
      matched_on: usedTerm,
      backed_off: backedOff,
      confidence: conf,
      food_id: Number(best.id),
      public_id: best.public_id,
      matched_name: best.name,
      contradicted: best.contradicted ?? null,
      base_name: best.base_name,
      derivation: best.derivation,
      wsim: Number(best.wsim).toFixed(3),
      alternatives: rows.slice(1).map((r) => r.name),
    } : { uses, normalised: term, confidence: 'none' };

    if (VERBOSE || conf === 'low' || conf === 'none') {
      console.log(`  ${conf.padEnd(6)} ${String(uses).padStart(4)}x  ${name.slice(0, 30).padEnd(30)}`
        + ` -> ${best ? String(best.name).slice(0, 44) : 'NO MATCH'}`);
    }
  }

  const total = ordered.length;
  const rows = Object.values(map);
  const covered = rows.filter((r) => r.confidence !== 'none');
  // Weight by usage too: a miss on "garlic" matters far more than one on a
  // one-off garnish, so the unweighted percentage alone would be misleading.
  const usesTotal = rows.reduce((n, r) => n + r.uses, 0);
  const usesCovered = covered.reduce((n, r) => n + r.uses, 0);
  const usesGood = rows.filter((r) => r.confidence === 'high' || r.confidence === 'medium')
    .reduce((n, r) => n + r.uses, 0);

  console.log('\n  by distinct ingredient:');
  for (const k of ['high', 'medium', 'low', 'none']) {
    console.log(`    ${k.padEnd(7)} ${String(tally[k]).padStart(4)}  ${((tally[k] / total) * 100).toFixed(1)}%`);
  }
  console.log(`\n  by ingredient USE across all 5,005 rows:`);
  console.log(`    matched at all      ${usesCovered}/${usesTotal}  ${((usesCovered / usesTotal) * 100).toFixed(1)}%`);
  console.log(`    high or medium      ${usesGood}/${usesTotal}  ${((usesGood / usesTotal) * 100).toFixed(1)}%`);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, 'ingredient_map.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), map }, null, 1));
  const review = Object.entries(map)
    .filter(([, v]) => v.confidence === 'low' || v.confidence === 'none')
    .sort((a, b) => b[1].uses - a[1].uses);
  writeFileSync(path.join(OUT_DIR, 'review_queue.json'),
    JSON.stringify(Object.fromEntries(review), null, 1));
  console.log(`\n  wrote out/ingredient_map.json and out/review_queue.json (${review.length} to review)`);
} catch (err) {
  // Without this the script failed SILENTLY: the only output was node's
  // "unsettled top-level await" warning, with the real error swallowed by
  // the bare try/finally. A resolver that can fail without saying why is
  // the same class of problem as a verifier nobody re-runs.
  console.error('');
  console.error('RESOLVE FAILED:', err && err.message ? err.message : err);
  let c = err && err.cause;
  while (c) { console.error('  caused by:', c.code || '', c.message || c); c = c.cause; }
  process.exitCode = 1;
} finally {
  await pool.end();
}
