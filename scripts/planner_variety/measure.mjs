// Measure plan variety across a week (checklist m5-07, task T6, 2026-11-21).
//
// READ ONLY. Plans 7 consecutive days for 4 profiles with the real catalogue
// pool, exactly as the planner route would with no preferences and nothing
// logged, and prints how often mains and sides repeat. Writes nothing: no
// events, no files. The laptop session runs it; the Pi has no .env.
//
// Usage (from backend/ so it reads backend/.env):
//   node scripts/planner_variety/measure.mjs
//   node scripts/planner_variety/measure.mjs --start=2026-11-23

import "dotenv/config";
import { db } from "../../src/config/db.js";
import { ADG_SERVE_TABLE } from "../../src/services/adgServeTargets.js";
import { buildCatalogRecommendations } from "../../src/services/catalogPlates.js";
import { buildMealCalorieTargets } from "../../src/services/mealSplit.js";
import { mealServeTargets } from "../../src/services/mealServePattern.js";
import { MEAL_TYPES } from "../../src/services/mealTypes.js";
import { formatVariety, summariseVariety } from "./varietyStats.js";

// T6, 2026-11-21: the brief's four profiles. Serve rows are copied by name
// from the ADG table, so they follow it if it changes. userId only seeds the
// planner; these ids belong to no real user and nothing is written for them.
const PROFILES = [
  { label: "woman 19-50, 2,000 kcal", userId: 990001, kcal: 2000, serveRow: "female_19_50", person: { age: 30 } },
  { label: "man 19-50, 2,800 kcal", userId: 990002, kcal: 2800, serveRow: "male_19_50", person: { age: 30 } },
  { label: "woman 51-70, 1,700 kcal", userId: 990003, kcal: 1700, serveRow: "female_51_70", person: { age: 60 } },
  { label: "pregnant, 2,200 kcal", userId: 990004, kcal: 2200, serveRow: "pregnant_19_plus", person: { age: 30, isPregnant: true } },
];
const DAYS = 7;

const startArg = process.argv.find((a) => a.startsWith("--start="))?.slice("--start=".length);
const start = startArg ? new Date(`${startArg}T00:00:00Z`) : new Date();
if (Number.isNaN(start.getTime())) {
  console.error("--start must be YYYY-MM-DD");
  process.exit(1);
}
const dayString = (offset) => {
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + offset));
  return d.toISOString().slice(0, 10);
};

async function main() {
  const slots = [...MEAL_TYPES];
  for (const profile of PROFILES) {
    const mealTargets = buildMealCalorieTargets(profile.kcal, { slots });
    const serveTargetsByMeal = mealServeTargets(ADG_SERVE_TABLE[profile.serveRow], { slots });
    const days = [];
    const shortBy = {};
    for (let i = 0; i < DAYS; i++) {
      const { recommendationsByMeal, blocked, shortByMeal } = await buildCatalogRecommendations({
        db,
        userId: profile.userId,
        dateStr: dayString(i),
        mealTypes: slots,
        mealTargets,
        serveTargetsByMeal,
        person: profile.person,
      });
      if (blocked.length > 0) throw new Error(`blocked: ${blocked.join(", ")}`);
      days.push(recommendationsByMeal);
      for (const [meal, n] of Object.entries(shortByMeal)) shortBy[meal] = (shortBy[meal] || 0) + n;
    }
    console.log(formatVariety(`${profile.label} (${dayString(0)} to ${dayString(DAYS - 1)})`, summariseVariety(days)));
    const short = Object.entries(shortBy).filter(([, n]) => n > 0);
    console.log(`  ideas missing over the week: ${short.map(([m, n]) => `${m} ${n}`).join(", ") || "none"}`);
    console.log("");
  }
  console.log("main repeat: share of cards whose main was on an EARLIER day. side repeat: the same for each side.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[planner_variety] FAILED:", err);
  process.exit(1);
});
