// Coverage for checklist m4-06: the daily fluid target.
// Expected values are typed from the NHMRC NRV water page ("Fluids" column),
// not read back from WATER_AI_TABLE, so a typo in the table fails here.
import test from "node:test";
import assert from "node:assert/strict";

import { WATER_AI_TABLE, resolveWaterTarget } from "./waterTarget.js";
import { resolveServeTargets } from "./adgServeTargets.js";

// [age, gender, pregnant, breastfeeding, expected row, expected mL]
const OFFICIAL_ROWS = [
  [16, "male", null, null, "male_14_18", 1900],
  [17, "female", null, null, "female_14_18", 1600],
  [17, "female", true, false, "pregnant_14_18", 1800],
  [18, "female", false, true, "lactating_14_18", 2300],
  [25, "male", null, null, "male_19_50", 2600],
  [60, "male", null, null, "male_51_70", 2600],
  [80, "male", null, null, "male_70_plus", 2600],
  [25, "female", null, null, "female_19_50", 2100],
  [60, "female", null, null, "female_51_70", 2100],
  [80, "female", null, null, "female_70_plus", 2100],
  [30, "female", true, false, "pregnant_19_plus", 2300],
  [30, "female", false, true, "lactating_19_plus", 2600],
];

for (const [age, gender, isPregnant, isBreastfeeding, row, fluidsMl] of OFFICIAL_ROWS) {
  test(`official water row ${row}`, () => {
    const result = resolveWaterTarget({ age, gender, isPregnant, isBreastfeeding });
    assert.equal(result.row, row);
    assert.equal(result.fluidsMl, fluidsMl);
    assert.equal(result.source, "nrv");
  });
}

test("every water table row is covered", () => {
  const covered = new Set(OFFICIAL_ROWS.map((r) => r[4]));
  assert.deepEqual([...covered].sort(), Object.keys(WATER_AI_TABLE).sort());
});

test("gender Other is the midpoint", () => {
  assert.equal(resolveWaterTarget({ age: 30, gender: "other" }).fluidsMl, 2350);
  assert.equal(resolveWaterTarget({ age: 17, gender: "other" }).fluidsMl, 1750);
});

test("pregnant and breastfeeding takes the larger figure", () => {
  assert.equal(resolveWaterTarget({ age: 30, gender: "female", isPregnant: true, isBreastfeeding: true }).fluidsMl, 2600);
  assert.equal(resolveWaterTarget({ age: 17, gender: "female", isPregnant: true, isBreastfeeding: true }).fluidsMl, 2300);
});

test("pregnancy is ignored for a male user, and pregnancy at 51+ uses the adult row", () => {
  assert.equal(resolveWaterTarget({ age: 30, gender: "male", isPregnant: true }).fluidsMl, 2600);
  assert.equal(resolveWaterTarget({ age: 52, gender: "female", isPregnant: true }).row, "pregnant_19_plus");
});

test("unknown age and gender still return a target, marked nrv_default", () => {
  const result = resolveWaterTarget();
  assert.equal(result.fluidsMl, 2350);
  assert.equal(result.source, "nrv_default");
});

test("water and serves always pick the same life stage for the same person", () => {
  const people = [];
  for (const age of [0, 16, 18, 19, 50, 51, 70, 71, 90]) {
    for (const gender of ["male", "female", "other", null]) {
      for (const [isPregnant, isBreastfeeding] of [[null, null], [true, false], [false, true], [true, true]]) {
        people.push({ age, gender, isPregnant, isBreastfeeding });
      }
    }
  }
  for (const person of people) {
    assert.equal(resolveWaterTarget(person).row, resolveServeTargets(person).row, JSON.stringify(person));
  }
});
