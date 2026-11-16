// Coverage for checklist m4-04: per-user ADG serve targets.
// Expected values are typed from the NHMRC Eat for Health tables (see the
// header of adgServeTargets.js), NOT read back from ADG_SERVE_TABLE, so a
// typo in the table fails here instead of being copied into the assertion.
import test from "node:test";
import assert from "node:assert/strict";

import { ADG_SERVE_TABLE, resolveServeTargets } from "./adgServeTargets.js";

const groups = (t) => [t.vegetable, t.fruit, t.grain, t.protein, t.dairy, t.additionalMax];

// [age, gender, pregnant, breastfeeding, expected row, expected serves]
const OFFICIAL_ROWS = [
  [16, "male", null, null, "male_14_18", [5.5, 2, 7, 2.5, 3.5, 5]],
  [17, "female", null, null, "female_14_18", [5, 2, 7, 2.5, 3.5, 2.5]],
  [17, "female", true, false, "pregnant_14_18", [5, 2, 8, 3.5, 3.5, 3]],
  [18, "female", false, true, "lactating_14_18", [5.5, 2, 9, 2.5, 4, 3]],
  [30, "male", null, null, "male_19_50", [6, 2, 6, 3, 2.5, 3]],
  [60, "male", null, null, "male_51_70", [5.5, 2, 6, 2.5, 2.5, 2.5]],
  [80, "male", null, null, "male_70_plus", [5, 2, 4.5, 2.5, 3.5, 2.5]],
  [30, "female", null, null, "female_19_50", [5, 2, 6, 2.5, 2.5, 2.5]],
  [60, "female", null, null, "female_51_70", [5, 2, 4, 2, 4, 2.5]],
  [80, "female", null, null, "female_70_plus", [5, 2, 3, 2, 4, 2]],
  [30, "female", true, false, "pregnant_19_plus", [5, 2, 8.5, 3.5, 2.5, 2.5]],
  [30, "female", false, true, "lactating_19_plus", [7.5, 2, 9, 2.5, 2.5, 2.5]],
];

for (const [age, gender, isPregnant, isBreastfeeding, row, expected] of OFFICIAL_ROWS) {
  test(`official row ${row}`, () => {
    const result = resolveServeTargets({ age, gender, isPregnant, isBreastfeeding });
    assert.equal(result.row, row);
    assert.equal(result.source, "adg");
    assert.deepEqual(groups(result), expected);
  });
}

test("every table row is covered by an official-row case", () => {
  const covered = new Set(OFFICIAL_ROWS.map((r) => r[4]));
  assert.deepEqual([...covered].sort(), Object.keys(ADG_SERVE_TABLE).sort());
});

test("age bands switch at 19, 51 and 71", () => {
  const rowAt = (age) => resolveServeTargets({ age, gender: "male" }).row;
  assert.equal(rowAt(18), "male_14_18");
  assert.equal(rowAt(19), "male_19_50");
  assert.equal(rowAt(50), "male_19_50");
  assert.equal(rowAt(51), "male_51_70");
  assert.equal(rowAt(70), "male_51_70");
  assert.equal(rowAt(71), "male_70_plus");
});

test("decision: gender Other is the male/female midpoint, rounded up to the half serve", () => {
  const adult = resolveServeTargets({ age: 30, gender: "other" });
  assert.equal(adult.row, "midpoint(male_19_50,female_19_50)");
  // veg (6+5)/2=5.5, fruit 2, grain 6, protein (3+2.5)/2=2.75 -> 3,
  // dairy 2.5, additional (3+2.5)/2=2.75 -> 3
  assert.deepEqual(groups(adult), [5.5, 2, 6, 3, 2.5, 3]);

  const older = resolveServeTargets({ age: 75, gender: "other" });
  // veg 5, fruit 2, grain (4.5+3)/2=3.75 -> 4, protein (2.5+2)/2=2.25 -> 2.5,
  // dairy (3.5+4)/2=3.75 -> 4, additional (2.5+2)/2=2.25 -> 2.5
  assert.deepEqual(groups(older), [5, 2, 4, 2.5, 4, 2.5]);
});

test("decision: pregnant and breastfeeding takes the larger row group by group", () => {
  const adult = resolveServeTargets({ age: 30, gender: "female", isPregnant: true, isBreastfeeding: true });
  assert.equal(adult.row, "max(pregnant_19_plus,lactating_19_plus)");
  assert.deepEqual(groups(adult), [7.5, 2, 9, 3.5, 2.5, 2.5]);

  const teen = resolveServeTargets({ age: 17, gender: "female", isPregnant: true, isBreastfeeding: true });
  assert.deepEqual(groups(teen), [5.5, 2, 9, 3.5, 4, 3]);
});

test("decision: pregnant at 51+ uses the adult pregnant row", () => {
  const result = resolveServeTargets({ age: 52, gender: "female", isPregnant: true, isBreastfeeding: false });
  assert.equal(result.row, "pregnant_19_plus");
});

test("pregnancy applies to Other as well as Female", () => {
  const result = resolveServeTargets({ age: 30, gender: "other", isPregnant: true, isBreastfeeding: false });
  assert.equal(result.row, "pregnant_19_plus");
});

test("pregnancy is ignored for a male user", () => {
  const result = resolveServeTargets({ age: 30, gender: "male", isPregnant: true, isBreastfeeding: true });
  assert.equal(result.row, "male_19_50");
});

test("not stated (null) and answered no (false) both give the ordinary row", () => {
  for (const value of [null, false, undefined]) {
    const result = resolveServeTargets({ age: 30, gender: "female", isPregnant: value, isBreastfeeding: value });
    assert.equal(result.row, "female_19_50");
  }
});

test("unknown age or gender still returns targets, marked adg_default", () => {
  const noAge = resolveServeTargets({ age: 0, gender: "female" });
  assert.equal(noAge.row, "female_19_50");
  assert.equal(noAge.source, "adg_default");

  const nothing = resolveServeTargets();
  assert.equal(nothing.row, "midpoint(male_19_50,female_19_50)");
  assert.equal(nothing.source, "adg_default");
});

test("gender is matched case-insensitively", () => {
  assert.equal(resolveServeTargets({ age: 30, gender: "Female" }).row, "female_19_50");
});
