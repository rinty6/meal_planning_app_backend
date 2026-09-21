/**
 * Display casing for Open Food Facts names and brands.
 *
 * OFF's product_name is free text typed by contributors, and a lot of them
 * copy the pack, which prints in capitals: 1,392 of the 45,718 AU products
 * arrived as "CHICKEN, LETTUCE & AVOCADO" and another 1,131 as "egg noodle".
 * Stage 1 (extract.py) keeps the contributor's text verbatim on purpose, so
 * off_au.json stays a faithful extract; this module is where the presentation
 * decision is made, at load time, and recase.js is the one-off backfill for
 * rows loaded before it existed (device pass 2026-09-21).
 *
 * Rules, in order:
 *   1. A string that already mixes upper and lower case carries the
 *      contributor's intent and is NEVER touched. That is 85% of rows.
 *   2. A string with no case information (all caps, all lower) is rebuilt in
 *      Title Case, word by word. Small words (and, with, of, the …) stay lower
 *      unless they lead. A capital follows a hyphen or slash ("Nutri-Grain")
 *      but not an apostrophe ("Kellogg's", never "Kellogg'S").
 *   3. Before defaulting, each word is looked up in a vocabulary built from
 *      the mixed-case rows of the same dataset. When the majority spelling
 *      there is irregular (BBQ, UHT, McDonald's, YoPRO, iSnack) that spelling
 *      wins; a plain Title or lower majority means "use the default". This is
 *      how acronyms survive without a hand-kept list.
 *   4. Brand-only guard: when a brand LEADS with an all-caps word of four
 *      letters or fewer that has no vocabulary entry, that word stays as typed
 *      (IGA, KFC, ALDI, 28GO, SPC Ardmona). Only the first word: "SUPERPOP PTY LTD"
 *      should still become "Superpop Pty Ltd". Food names get no such guard;
 *      short food words (EGG, BEEF, MILK) are covered by rule 3 anyway.
 *
 * Nothing here changes letters, only their case, so normalized_name and
 * base_name (both lower-cased copies) are unaffected and search is untouched.
 */

const SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'de', 'du', 'for', 'from', 'in', 'into',
  'la', 'le', 'n', 'nor', 'of', 'on', 'or', 'per', 'the', 'to', 'vs', 'with', 'without',
]);

// Minimum times an irregular spelling must appear, and its share of all
// spellings of that word, before it overrides the default.
const VOCAB_MIN_COUNT = 2;
const VOCAB_MIN_SHARE = 0.5;
const BRAND_ACRONYM_MAX = 4;

const LETTER = /\p{L}/u;
const DIGIT = /\p{N}/u;
const UPPER = /\p{Lu}/u;
const LOWER = /\p{Ll}/u;

/** True when the text has at least one upper AND one lower case letter. */
export const hasCaseInformation = (text) => UPPER.test(text) && LOWER.test(text);

// A "word" is a run of letters, digits, apostrophes, hyphens and slashes.
// Everything between words (spaces, commas, brackets, ampersands) passes
// through unchanged.
const WORD = /[\p{L}\p{N}'’\-\/]+/gu;

const titleWord = (word) => {
  // Capitalise the first letter and any letter after '-' or '/'; lower the
  // rest. Punctuation BEFORE the first letter is transparent ("'n'" -> "'N'"),
  // an apostrophe after it is not ("kellogg's" -> "Kellogg's"), and letters
  // after digits are units, so they go lower ("330G" -> "330g").
  let out = '';
  let capitalise = true;
  let seenAlnum = false;
  for (const ch of word) {
    if (LETTER.test(ch)) {
      out += capitalise ? ch.toUpperCase() : ch.toLowerCase();
      capitalise = false;
      seenAlnum = true;
    } else {
      out += ch;
      if (DIGIT.test(ch)) {
        capitalise = false;
        seenAlnum = true;
      } else {
        capitalise = ch === '-' || ch === '/' || !seenAlnum;
      }
    }
  }
  return out;
};

const isRegular = (form, key) => form === key || form === titleWord(key);

/**
 * Build the word -> preferred spelling map from every string that has case
 * information. `strings` can be any iterable of names and brand names.
 */
export const buildCaseVocabulary = (strings) => {
  const counts = new Map(); // key -> Map(form -> n)
  for (const text of strings) {
    if (!text || !hasCaseInformation(text)) continue;
    for (const form of text.match(WORD) ?? []) {
      if (!LETTER.test(form)) continue;
      const key = form.toLowerCase();
      let forms = counts.get(key);
      if (!forms) counts.set(key, (forms = new Map()));
      forms.set(form, (forms.get(form) ?? 0) + 1);
    }
  }
  const vocab = new Map();
  for (const [key, forms] of counts) {
    let total = 0;
    let best = null;
    for (const [form, n] of forms) {
      total += n;
      if (!best || n > best.n) best = { form, n };
    }
    if (isRegular(best.form, key)) continue;
    if (best.n < VOCAB_MIN_COUNT || best.n / total < VOCAB_MIN_SHARE) continue;
    vocab.set(key, best.form);
  }
  return vocab;
};

/**
 * Recase one string. Returns the input unchanged when it already has case
 * information or contains no letters.
 */
export const displayCase = (text, vocab = new Map(), { brand = false } = {}) => {
  if (typeof text !== 'string' || !LETTER.test(text) || hasCaseInformation(text)) return text;
  let first = true;
  return text.replace(WORD, (word) => {
    if (!LETTER.test(word)) return word; // "330", "10x375", pure digits
    const key = word.toLowerCase();
    const lead = first;
    first = false;
    const known = vocab.get(key);
    if (known) return known;
    if (!lead && SMALL_WORDS.has(key)) return key;
    if (brand && lead && word === word.toUpperCase() && key.length <= BRAND_ACRONYM_MAX) {
      return word;
    }
    return titleWord(key);
  });
};

/**
 * Apply the rules to a whole off_au.json payload. The vocabulary is built from
 * the same payload, so a re-extract with new mixed-case rows can only improve
 * the result. Returns new food/brand arrays; the input is not mutated.
 */
export const recasePayload = (payload) => {
  const vocab = buildCaseVocabulary([
    ...payload.foods.map((f) => f.name),
    ...payload.brands.map((b) => b.name),
  ]);
  return {
    vocab,
    foods: payload.foods.map((f) => ({ ...f, name: displayCase(f.name, vocab) })),
    brands: payload.brands.map((b) => ({ ...b, name: displayCase(b.name, vocab, { brand: true }) })),
  };
};
