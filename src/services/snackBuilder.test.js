// Coverage for task P4 (2026-11-20): the snack slot. Small fake foods so each
// rule is checked on its own. Throwaway sprint test (checklist m7-06).
import test from "node:test";
import assert from "node:assert/strict";

import { buildSnacks, passesHalfServe, snackFamily } from "./snackBuilder.js";
import { primaryGroup } from "./plateBuilder.js";
import { shortNameFor } from "./plannerPool.js";

let nextId = 1;
/** kcal and serves are per 100 g; the first serving is the default. */
const food = (name, group, kcal, serves, servings) => ({
  id: nextId++,
  publicId: `food_${nextId}`,
  name,
  shortName: name.split(",")[0],
  group,
  image: null,
  per100g: { calories_kcal: kcal, energy_kj: kcal * 4.184, protein_g: 3 },
  serves100g: { grain: 0, vegetable: 0, fruit: 0, dairy: 0, protein: 0, ...serves },
  servings: servings.map(([description, grams], i) => ({ description, grams, isDefault: i === 0 })),
  verdicts: {},
});

const fruit = (n) => food(`Apple ${n}, raw`, "ausnut-161", 52, { fruit: 0.67 }, [["1 apple (150 g)", 150]]);
const pear = (n) => food(`Pear ${n}, raw`, "ausnut-161", 58, { fruit: 0.67 }, [["1 pear (160 g)", 160]]);
const berry = (n) => food(`Strawberry ${n}, raw`, "ausnut-162", 30, { fruit: 0.67 }, [["1 cup (150 g)", 150]]);
const cheddar = (n) => food(`Cheddar ${n}, regular fat`, "ausnut-194", 400, { dairy: 2.5 }, [["1 slice (21 g)", 21], ["1 cup grated (40 g)", 40]]);
const yoghurt = (n) => food(`Yoghurt ${n}, natural`, "ausnut-192", 90, { dairy: 0.5 }, [["1 tub (140 g)", 140], ["1 cup (200 g)", 200]]);
const milk = (n) => food(`Milk ${n}, cow, fluid`, "ausnut-191", 64, { dairy: 0.4 }, [["1 glass (250 ml)", 250]]);
const almonds = () => food("Almond, raw", "ausnut-222", 600, { protein: 3.33 }, [["1 handful (30 g)", 30]]);
const crackers = (n) => food(`Crispbread ${n}, rye`, "ausnut-132", 380, { grain: 3.33 }, [["4 crackers (20 g)", 20]]);
const hummus = (n) => food(`Hummus ${n}, commercial`, "ausnut-235", 250, { protein: 1 }, [["1 tub (60 g)", 60]]);
const rawCarrot = () => food("Carrot, raw", "ausnut-243", 35, { vegetable: 1.33 }, [["1 carrot (129 g)", 129]]);
const boiledCarrot = () => food("Carrot, boiled", "ausnut-243", 30, { vegetable: 1.33 }, [["1 cup (150 g)", 150]]);
const driedFruit = (name) => food(`${name}, dried`, "ausnut-168", 280, { fruit: 3.33 }, [["1 small box (40 g)", 40]]);

const everyday = () => [
  ...[0, 1, 2].map(fruit), ...[0, 1].map(pear), ...[0, 1].map(berry), ...[0, 1, 2].map(cheddar), ...[0, 1, 2].map(yoghurt),
  ...[0, 1].map(milk), almonds(), ...[0, 1].map(crackers), ...[0, 1].map(hummus), rawCarrot(), boiledCarrot(),
];
const familyOfItem = (item) => snackFamily({ name: item.name, group: item.group });

test("no cake, custard or dairy dessert ever appears", () => {
  const sweet = [
    food("Scone, plain", "ausnut-133", 330, { grain: 2 }, [["1 scone (60 g)", 60]]),
    food("Custard, vanilla", "ausnut-196", 110, { dairy: 0.5 }, [["1 tub (150 g)", 150]]),
    food("Dairy dessert, chocolate", "ausnut-197", 130, { dairy: 0.5 }, [["1 tub (150 g)", 150]]),
  ];
  for (let seed = 1; seed <= 10; seed++) {
    const { plates } = buildSnacks({ foods: [...sweet, ...everyday()], targetKcal: 200, seed });
    const groups = plates.flatMap((p) => p.items.map((i) => i.group));
    assert.ok(!groups.some((g) => ["ausnut-133", "ausnut-196", "ausnut-197"].includes(g)), groups.join(","));
  }
});

test("crackers and dips are never alone; a raw carrot only with dip or cheese; a cooked carrot never", () => {
  for (let seed = 1; seed <= 10; seed++) {
    const { plates } = buildSnacks({ foods: everyday(), targetKcal: 200, seed });
    assert.equal(plates.length, 5);
    for (const p of plates) {
      const families = p.items.map(familyOfItem);
      if (p.items.length === 1) assert.ok(!["crackers", "dip", "rawveg"].includes(families[0]), p.title);
      if (families.includes("rawveg")) {
        assert.equal(p.items.length, 2, p.title);
        assert.ok(families.includes("dip") || families.includes("cheese"), p.title);
      }
      assert.ok(!p.items.some((i) => i.name === "Carrot, boiled"), p.title);
      assert.equal(p.meal, "snack");
      assert.equal(p.shape, "snack");
    }
  }
});

test("pairs only from the pair list", () => {
  const allowed = new Set(["fruit+cheese", "fruit+yoghurt", "fruit+nuts", "yoghurt+nuts", "cheese+crackers", "cheese+rawveg",
    "rawveg+dip", "crackers+dip", "milk+fruit"].flatMap((p) => [p, p.split("+").reverse().join("+")]));
  for (let seed = 1; seed <= 10; seed++) {
    for (const p of buildSnacks({ foods: everyday(), targetKcal: 200, seed }).plates) {
      if (p.items.length === 2) assert.ok(allowed.has(p.items.map(familyOfItem).join("+")), p.title);
    }
  }
});

test("1 tablespoon of coconut fails the half-serve rule and is never used", () => {
  const coconut = food("Coconut, desiccated", "ausnut-221", 660, { protein: 0 }, [["1 tbsp (5 g)", 5]]);
  assert.equal(passesHalfServe(coconut, 5), false);
  assert.equal(passesHalfServe(almonds(), 30), true);
  const { plates } = buildSnacks({ foods: [coconut, ...everyday()], targetKcal: 200, seed: 3 });
  assert.ok(plates.every((p) => p.items.every((i) => !i.name.startsWith("Coconut"))));
});

test("dried fruit appears on at most one of the five snacks", () => {
  const dried = ["Apricot", "Sultana", "Date", "Fig", "Prune", "Cranberry"].map(driedFruit);
  for (let seed = 1; seed <= 10; seed++) {
    const { plates } = buildSnacks({ foods: [...dried, ...[0, 1].map(yoghurt), ...[0, 1].map(cheddar), almonds()], targetKcal: 200, seed });
    const withDried = plates.filter((p) => p.items.some((i) => i.group === "ausnut-168"));
    assert.ok(withDried.length <= 1, `seed ${seed}: ${withDried.map((p) => p.title).join(" | ")}`);
  }
});

test("a snack short of dairy picks a dairy first food more often", () => {
  const countDairyFirst = (serveTarget) => {
    let n = 0;
    for (let seed = 1; seed <= 10; seed++) {
      for (const p of buildSnacks({ foods: everyday(), targetKcal: 200, seed, serveTarget }).plates) {
        if (primaryGroup({ serves100g: p.items[0].serves }) === "dairy") n++;
      }
    }
    return n;
  };
  const dairyShort = { vegetable: 0, fruit: 0.2, grain: 0, protein: 0, dairy: 1.5 };
  const fruitShort = { vegetable: 0, fruit: 1.5, grain: 0, protein: 0, dairy: 0.2 };
  const a = countDairyFirst(dairyShort);
  const b = countDairyFirst(fruitShort);
  assert.ok(a > b, `${a} vs ${b}`);
});

test("a handful of almonds alone is a valid snack", () => {
  const { plates } = buildSnacks({ foods: [almonds()], targetKcal: 200, seed: 1 });
  assert.equal(plates.length, 1);
  assert.equal(plates[0].items.length, 1);
  assert.equal(plates[0].title, "Almond");
  assert.equal(plates[0].items[0].serving.description, "1 handful (30 g)");
});

test("titles join two short names with &", () => {
  const { plates } = buildSnacks({ foods: [fruit(9), cheddar(9)], targetKcal: 170, seed: 1 });
  assert.ok(plates.some((p) => /^(Apple 9 & cheddar 9|Cheddar 9 & apple 9)$/.test(p.title)), plates.map((p) => p.title).join(" | "));
});

test("no target, no snacks", () => {
  assert.deepEqual(buildSnacks({ foods: everyday(), targetKcal: 0 }), { plates: [], shortBy: 5 });
});

test("a dip's short name is the dip, not \"Dip\"", () => {
  assert.equal(shortNameFor({ name: "Dip, hummus (hommus), commercial", baseName: "dip", nameSegments: ["hummus (hommus)", "commercial"] }), "Hummus");
  assert.equal(shortNameFor({ name: "Dip, tzatziki", baseName: "dip", nameSegments: ["tzatziki"] }), "Tzatziki");
});
