// The allergen and diet filter. Runs against the live Neon database named by
// ENV.DB_URL (there is no fixture catalogue), so it needs backend/.env and a
// network. Run: node --test src/services/foodAttributeFilter.test.js
//
// The test that earns its keep is "sql and js agree": the SQL predicate and
// the JS evaluator encode the same two rules twice, and nothing but a test
// keeps them in step. Everything else here guards one of those rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { db } from "../config/db.js";
import {
  ALLERGEN_SLUGS,
  DIET_SLUGS,
  FLEXIBLE,
  STRICT,
  attributeVerdictsSql,
  buildAttributeFilters,
  evaluateFood,
  flaggedAllergensFor,
  modeFor,
  normalizeAllergens,
  normalizeDiets,
} from "./foodAttributeFilter.js";

const PROFILES = [
  { name: "milk, strict", allergens: ["milk"] },
  { name: "gluten group, strict", allergens: ["gluten"] },
  { name: "tree nuts + peanut, strict", allergens: ["treenut", "peanut"] },
  { name: "milk + egg + nuts, strict", allergens: ["milk", "egg", "treenut", "peanut"] },
  { name: "vegan, strict", diets: ["vegan"] },
  { name: "vegan + milk flexible", diets: ["vegan"], allergens: ["milk"],
    strictness: { milk: FLEXIBLE } },
  { name: "everything flexible", allergens: ["milk", "gluten"], diets: ["vegetarian"],
    defaultStrictness: FLEXIBLE },
];

const runSql = async (profile) => {
  const { filters } = buildAttributeFilters({ foodIdColumn: "f.id", ...profile });
  const where = filters.length
    ? sql.join([sql`f.food_type = 'generic'`, ...filters], sql` and `)
    : sql`f.food_type = 'generic'`;
  const rows = await db.execute(
    sql`select f.id from catalog_foods f where ${where} order by f.id`);
  return new Set((rows.rows ?? rows).map((r) => Number(r.id)));
};

// ---------------------------------------------------------------- normalizing
test("group names expand to the FSANZ slugs", () => {
  assert.deepEqual(normalizeAllergens(["gluten"]).slugs,
    ["wheat", "barley", "oats", "rye"]);
  assert.equal(normalizeAllergens(["treenut"]).slugs.length, 9);
  assert.deepEqual(normalizeAllergens(["shellfish"]).slugs,
    ["crustacean", "mollusc"]);
});

test("unrecognised input is dropped AND reported, never silently discarded", () => {
  const { slugs, ignored } = normalizeAllergens(["milk", "Dairy", "peanutt"]);
  assert.deepEqual(slugs, ["milk"]);
  assert.deepEqual(ignored, ["Dairy", "peanutt"]);
  assert.deepEqual(normalizeDiets(["vegan", "paleo"]).ignored, ["paleo"]);
});

test("strict is the default, and anything unrecognised means strict", () => {
  assert.equal(modeFor("milk", {}), STRICT);
  assert.equal(modeFor("milk", { milk: "nonsense" }), STRICT);
  assert.equal(modeFor("milk", { milk: FLEXIBLE }), FLEXIBLE);
  // per allergen, not per user
  const s = { peanut: STRICT, lactose: FLEXIBLE };
  assert.equal(modeFor("peanut", s), STRICT);
  assert.equal(modeFor("lactose", s), FLEXIBLE);
});

// ---------------------------------------------------------------- the rules
test("RULE 1: unknown never passes in strict mode", () => {
  const r = evaluateFood({ milk: -1 }, { allergens: ["milk"] });
  assert.equal(r.passes, false);
  assert.deepEqual(r.blockedBy, ["milk"]);
});

test("RULE 1: unknown passes in flexible mode, and is flagged", () => {
  const r = evaluateFood({ milk: -1 },
    { allergens: ["milk"], strictness: { milk: FLEXIBLE } });
  assert.equal(r.passes, true);
  assert.deepEqual(r.flaggedBy, ["milk"]);
  assert.deepEqual(flaggedAllergensFor({ allergens: ["milk"],
    strictness: { milk: FLEXIBLE } }), ["milk"]);
});

test("RULE 2: a MISSING verdict is unknown, not free", () => {
  // the branded case: no row at all
  assert.equal(evaluateFood({}, { allergens: ["milk"] }).passes, false);
  assert.equal(evaluateFood({ egg: 0 }, { allergens: ["milk"] }).passes, false);
});

test("contains never passes, in either mode", () => {
  for (const strictness of [{}, { milk: FLEXIBLE }]) {
    const r = evaluateFood({ milk: 1 }, { allergens: ["milk"], strictness });
    assert.equal(r.passes, false, JSON.stringify(strictness));
    assert.deepEqual(r.blockedBy, ["milk"]);
  }
});

test("diet polarity is inverted: 1 means IS vegan", () => {
  assert.equal(evaluateFood({ vegan: 1 }, { diets: ["vegan"] }).passes, true);
  assert.equal(evaluateFood({ vegan: 0 }, { diets: ["vegan"] }).passes, false);
  assert.equal(evaluateFood({ vegan: -1 }, { diets: ["vegan"] }).passes, false);
});

// ---------------------------------------------------------------- live data
test("the published data is there to filter on", async () => {
  const r = await db.execute(sql`
    select a.kind, count(*)::int as n from food_attributes fa
    join attributes a on a.id = fa.attribute_id group by 1`);
  const byKind = Object.fromEntries((r.rows ?? r).map((x) => [x.kind, Number(x.n)]));
  assert.equal(byKind.allergen, 3741 * ALLERGEN_SLUGS.length);
  assert.equal(byKind.diet, 3741 * DIET_SLUGS.length);
});

test("sql and js agree, on every profile, over all 3,741 generic foods", async () => {
  const verdictRows = await db.execute(sql`
    select f.id, ${attributeVerdictsSql("f.id")} as verdicts
    from catalog_foods f where f.food_type = 'generic'`);
  const verdicts = new Map((verdictRows.rows ?? verdictRows)
    .map((r) => [Number(r.id), r.verdicts]));
  assert.equal(verdicts.size, 3741);

  for (const profile of PROFILES) {
    const fromSql = await runSql(profile);
    const fromJs = new Set();
    for (const [id, v] of verdicts) {
      if (evaluateFood(v, profile).passes) fromJs.add(id);
    }
    const onlySql = [...fromSql].filter((id) => !fromJs.has(id));
    const onlyJs = [...fromJs].filter((id) => !fromSql.has(id));
    assert.deepEqual(
      { onlySql: onlySql.slice(0, 5), onlyJs: onlyJs.slice(0, 5) },
      { onlySql: [], onlyJs: [] },
      `${profile.name}: sql kept ${fromSql.size}, js kept ${fromJs.size}`);
  }
});

test("RULE 2 in SQL: no branded food survives a strict filter", async () => {
  // 46,002 branded products have NO attribute rows. A filter written as
  // "exclude where value = 1" would pass every one of them to an allergic
  // user. This is the test that catches that rewrite.
  const { filters } = buildAttributeFilters({ allergens: ["milk"] });
  const r = await db.execute(sql`
    select count(*)::int as n from catalog_foods f
    where f.food_type <> 'generic' and ${sql.join(filters, sql` and `)}`);
  assert.equal(Number((r.rows ?? r)[0].n), 0);
});

test("flexible always admits at least as many foods as strict", async () => {
  for (const allergens of [["milk"], ["gluten"], ["peanut"]]) {
    const strict = await runSql({ allergens });
    const flexible = await runSql({ allergens, defaultStrictness: FLEXIBLE });
    assert.ok(flexible.size >= strict.size,
      `${allergens}: flexible ${flexible.size} < strict ${strict.size}`);
    for (const id of strict) {
      assert.ok(flexible.has(id), `${allergens}: food ${id} strict but not flexible`);
    }
  }
});

test("no filters means no exclusions", async () => {
  const all = await runSql({});
  assert.equal(all.size, 3741);
});

test("known foods land where Phase A1 said they would", async () => {
  // Scoped to generic: branded products share several of these names
  // ("Honey" alone returns 14 rows) and have no attribute rows at all, so
  // without this the lookup keeps a branded row and every verdict is missing.
  // That is rule 2 doing its job, caught by this test's own first run.
  const rows = await db.execute(sql`
    select f.name, ${attributeVerdictsSql("f.id")} as v
    from catalog_foods f
    where f.food_type = 'generic' and f.name in (
      'Custard, dairy, vanilla, commercial',
      'Beer, full strength (alcohol 4-4.9% v/v)',
      'Yoghurt, coconut, natural',
      'Tofu (soy bean curd), cooked',
      'Honey')`);
  const byName = Object.fromEntries((rows.rows ?? rows).map((r) => [r.name, r.v]));

  assert.equal(evaluateFood(byName["Custard, dairy, vanilla, commercial"],
    { allergens: ["milk"] }).passes, false);
  assert.equal(evaluateFood(byName["Beer, full strength (alcohol 4-4.9% v/v)"],
    { allergens: ["gluten"] }).passes, false);
  // a dairy substitute must survive a milk filter: it is the whole point
  assert.equal(evaluateFood(byName["Yoghurt, coconut, natural"],
    { allergens: ["milk"] }).passes, true);
  assert.equal(evaluateFood(byName["Tofu (soy bean curd), cooked"],
    { diets: ["vegan"] }).passes, true);
  assert.equal(evaluateFood(byName.Honey, { diets: ["vegan"] }).passes, false);
  assert.equal(evaluateFood(byName.Honey, { diets: ["vegetarian"] }).passes, true);
});
