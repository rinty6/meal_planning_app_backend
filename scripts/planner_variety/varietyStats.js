// Variety across a week of plans (checklist m5-07, task T6, 2026-11-21).
// Pure: measure.mjs builds the plans, this only counts. A tool, not a change
// to the planner: "a large pool must not produce the same five meals" is
// measured before anything is tuned.

// T6, 2026-11-21: the brief asks for the 5 most repeated foods per meal.
export const TOP_REPEATED = 5;

const foodKey = (item) => item?.food_id ?? item?.externalId ?? item?.id ?? item?.food_name ?? null;
const foodName = (item) => item?.food_name ?? item?.title ?? String(foodKey(item));
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * One role (mains or sides) for one meal over the week.
 * `usesByDay` is, per day in order, the list of { key, name } used that day
 * (one per card for mains, one per side for sides).
 */
const roleStats = (usesByDay) => {
  const seenBefore = new Set();
  const counts = new Map();
  let uses = 0;
  let repeats = 0;
  for (const dayUses of usesByDay) {
    for (const use of dayUses) {
      uses += 1;
      if (seenBefore.has(use.key)) repeats += 1;
      const entry = counts.get(use.key) || { name: use.name, count: 0 };
      entry.count += 1;
      counts.set(use.key, entry);
    }
    // Only EARLIER days count: two cards on the same day are not a repeat.
    for (const use of dayUses) seenBefore.add(use.key);
  }
  const top = [...counts.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, TOP_REPEATED);
  return { uses, repeatShare: uses > 0 ? round2(repeats / uses) : 0, distinct: counts.size, top };
};

/**
 * @param {Array<Record<string, object[]>>} daysByMeal  one entry per day, in
 *        order: { breakfast: [plate items], lunch: [...], ... } as
 *        buildCatalogRecommendations returns recommendationsByMeal. Each
 *        item's `items` has the main first.
 * @returns {Record<string, { cards: number, mains: object, sides: object }>}
 *   mains.repeatShare: the share of cards whose MAIN appeared on an earlier
 *   day. sides.repeatShare: the share of side uses whose food appeared as a
 *   side on an earlier day. distinct: different foods over the week. top: the
 *   TOP_REPEATED most used foods with their counts.
 */
export const summariseVariety = (daysByMeal = []) => {
  const meals = [];
  for (const day of daysByMeal) {
    for (const meal of Object.keys(day || {})) if (!meals.includes(meal)) meals.push(meal);
  }
  const out = {};
  for (const meal of meals) {
    const mainsByDay = [];
    const sidesByDay = [];
    let cards = 0;
    for (const day of daysByMeal) {
      const items = Array.isArray(day?.[meal]) ? day[meal] : [];
      cards += items.length;
      mainsByDay.push(items
        .map((card) => card?.items?.[0])
        .filter((main) => foodKey(main) !== null)
        .map((main) => ({ key: foodKey(main), name: foodName(main) })));
      sidesByDay.push(items.flatMap((card) => (card?.items || []).slice(1))
        .filter((side) => foodKey(side) !== null)
        .map((side) => ({ key: foodKey(side), name: foodName(side) })));
    }
    if (cards === 0) continue;
    out[meal] = { cards, mains: roleStats(mainsByDay), sides: roleStats(sidesByDay) };
  }
  return out;
};

/** Plain text table for stdout. */
export const formatVariety = (label, stats) => {
  const lines = [`== ${label}`];
  lines.push("meal       cards  main repeat  mains  side repeat  sides");
  for (const [meal, s] of Object.entries(stats)) {
    lines.push([
      meal.padEnd(10),
      String(s.cards).padStart(5),
      `${Math.round(s.mains.repeatShare * 100)}%`.padStart(12),
      String(s.mains.distinct).padStart(6),
      `${Math.round(s.sides.repeatShare * 100)}%`.padStart(12),
      String(s.sides.distinct).padStart(6),
    ].join(" "));
  }
  for (const [meal, s] of Object.entries(stats)) {
    lines.push(`  ${meal} top mains: ${s.mains.top.map((t) => `${t.name} x${t.count}`).join("; ") || "none"}`);
    lines.push(`  ${meal} top sides: ${s.sides.top.map((t) => `${t.name} x${t.count}`).join("; ") || "none"}`);
  }
  return lines.join("\n");
};
