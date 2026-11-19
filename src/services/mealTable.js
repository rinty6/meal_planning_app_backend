// Which foods can go on which meal's plate, and as what (checklist m5-01, D2).
//
// The catalogue has no meal information of its own: the tag-* attributes are
// recipe-only and no food carries one. Every food does sit in one of 104
// AUSNUT sub-major groups ("Breakfast cereals, ready to eat", "Fin fish"...),
// so the user approved a table, on 2026-11-19, that gives each group its
// meals and a role. Review page: claude_memory/database redesign/meal planning
// redesign/MEAL_TABLE_REVIEW.html. The data is src/data/mealTable.json.
//
//   kind  plate  can go on a plate, in the roles given per meal
//         drink  held for the drink slot (m5-04), never on a plate
//         never  never suggested; still searchable and loggable
//   role  main | side | main/side | null (not in that meal)
//
// A group missing from the table is "never". New catalogue groups therefore
// stay out of plates until someone decides where they belong, rather than
// appearing in breakfast by accident.
import { readFileSync } from "node:fs";

export const PLATE_MEALS = Object.freeze(["breakfast", "lunch", "dinner", "snack"]);
const KINDS = new Set(["plate", "drink", "never"]);
const ROLES = new Set(["main", "side", "main/side"]);

/** Throws on any malformed row, so a bad edit fails at startup, not mid-plan. */
export const validateMealTable = (table) => {
  if (!Array.isArray(table?.rows) || table.rows.length === 0) {
    throw new Error("meal table has no rows");
  }
  const seen = new Set();
  for (const row of table.rows) {
    if (!row?.code) throw new Error("meal table row without a code");
    if (seen.has(row.code)) throw new Error(`meal table repeats ${row.code}`);
    seen.add(row.code);
    if (!KINDS.has(row.kind)) throw new Error(`meal table ${row.code}: unknown kind "${row.kind}"`);
    for (const meal of PLATE_MEALS) {
      const role = row[meal];
      if (role == null) continue;
      if (!ROLES.has(role)) throw new Error(`meal table ${row.code}: unknown role "${role}" for ${meal}`);
      if (row.kind !== "plate") throw new Error(`meal table ${row.code}: a ${row.kind} row cannot have a ${meal} role`);
    }
  }
  return table;
};

/** code -> row, for the table actually in use. */
export const indexMealTable = (table) =>
  new Map(validateMealTable(table).rows.map((row) => [row.code, row]));

const loadDefaultTable = () =>
  JSON.parse(readFileSync(new URL("../data/mealTable.json", import.meta.url), "utf8"));

let defaultIndex = null;
const getDefaultIndex = () => {
  if (!defaultIndex) defaultIndex = indexMealTable(loadDefaultTable());
  return defaultIndex;
};

/** "plate" | "drink" | "never" for a sub-group code. Unknown codes are "never". */
export const kindFor = (code, index = getDefaultIndex()) => index.get(code)?.kind ?? "never";

/**
 * The roles a sub-group may take in a meal, as an array of "main" / "side".
 * Empty when the group is not on plates in that meal.
 */
export const rolesFor = (code, meal, index = getDefaultIndex()) => {
  const row = index.get(code);
  if (!row || row.kind !== "plate") return [];
  const role = row[meal];
  if (!role) return [];
  return role === "main/side" ? ["main", "side"] : [role];
};
