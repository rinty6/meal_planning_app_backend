// The shape of a plate (checklist m5-01 follow-up, task P2, 2026-11-20).
//
// Until now every main got one or two sides chosen by food group alone, so a
// hamburger came with frozen strawberries and yoghurt, and a pizza with
// bamboo shoots (300 live plates, HOW_AUSTRALIANS_EAT.html). Real meals have
// a shape: a burger or a sandwich is a whole meal on its own, a curry needs
// rice, a steak comes with a starchy and a green vegetable, cereal comes with
// milk. The user approved this on 2026-11-20 (decision Q1: whole dishes stand
// alone or with at most one side that goes with them).
//
// shapeFor() names the shape of a MAIN; slotsFor() lists the side slots that
// shape has, each a set of AUSNUT sub-groups. plateBuilder fills required
// slots first and optional slots only when the plate has room for them.
//
// Order of the rules: `whole` wins over everything, then the name rules, then
// the food group.

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `ausnut-${from + i}`);
const groups = (...codes) => new Set(codes.flat().map((c) => (typeof c === "number" ? `ausnut-${c}` : c)));

export const SHAPES = Object.freeze(["whole", "needs_starch", "meat_and_veg", "cereal", "toast", "eggs", "snack"]);

// P2, 2026-11-20: a complete meal on its own, whatever its group. From the
// brief, unchanged.
export const WHOLE_BY_NAME =
  /\bsandwich|\broll\b|burger|wrap\b|pizza|\bbowl\b|sushi|lasagne|risotto|paella|fried rice|kebab|taco|burrito|nachos|\bpie\b|with (rice|noodles|pasta|potato|mash|chips|bread|toast|english muffin)\b/i;
// P2, 2026-11-20: a salad with a protein in it is a meal ("Salad, chicken caesar").
// Bacon and ham added in the live review of 2026-11-20 ("Salad, garden, added
// bacon" was offered as a dinner side).
const PROTEIN_SALAD = /^salad\b.*\b(chicken|beef|lamb|pork|bacon|ham|tuna|salmon|prawn|egg|tofu|lentil|chickpea|haloumi|feta)\b/i;
// P2, 2026-11-20: dishes eaten over a starch, when no starch is in the name.
// "stew" is matched as a word so stewed fruit ("Apple, stewed") is not a stew.
const NEEDS_STARCH_BY_NAME = /curry|stir-?fry|casserole|\bstews?\b|goulash|chilli con carne|bolognai?se/i;

// P2, 2026-11-20: groups that are whole dishes by nature: cereal based mixed
// dishes (sandwiches, burgers, pizza, wraps, pasta dishes, sushi), fish mixed
// dishes and soups.
const WHOLE_GROUPS = groups(135, 156, range(211, 216));
// P2, 2026-11-20: plain breads (122 breads and rolls, 123 flat breads and
// English muffins) never count as whole by name. Without this "Bread, roll"
// matches \broll\b and a plain tortilla matches wrap\b, and a bread roll would
// be offered as a meal on its own. Sandwiches and filled wraps sit in 135.
const PLAIN_BREAD_GROUPS = groups(122, 123);
const SOUP_GROUPS = groups(range(211, 216));
const NEEDS_STARCH_GROUPS = groups(187, 188, 189); // meat and poultry mixed dishes
const MEAT_AND_VEG_GROUPS = groups(range(151, 155), range(181, 185), 206, 251, 252);
const EGG_GROUPS = groups(171, 172);
const CEREAL_GROUPS = groups(125, 126, 192, 205, 169);
const TOAST_GROUPS = groups(122, 123, 136);
const DAIRY_MAIN_GROUPS = groups(192, 205); // yoghurt is already the dairy
// Live review, 2026-11-20: porridge "made with cow's milk" was given a glass of
// cashew milk as well. A cereal cooked or served in milk has its dairy already.
const MADE_WITH_MILK = /\b(made with|with)\b[^,]*\b(milk|dairy)\b/i;

/**
 * Not a side, whatever slot asks (live review, 2026-11-20). A poke bowl was
 * offered as the "green" side of a salad, and chicken caesar beside a pizza:
 * a whole dish or a salad with meat in it is a meal of its own.
 */
export const isWholeDish = (food) => {
  const name = String(food?.name || "");
  const group = String(food?.group || "");
  if (WHOLE_GROUPS.has(group)) return true;
  if (!PLAIN_BREAD_GROUPS.has(group) && WHOLE_BY_NAME.test(name)) return true;
  return PROTEIN_SALAD.test(name);
};

/**
 * The shape of a main food in a meal, or null when the food is not a main at
 * all in that meal.
 * @param {{ name: string, group: string }} food  a pool food
 * @param {string} meal  "breakfast" | "lunch" | "dinner" | "snack"
 * @returns {string|null} one of SHAPES, or null
 */
export const shapeFor = (food, meal) => {
  if (meal === "snack") return "snack"; // snacks are built by snackBuilder (P4)
  const name = String(food?.name || "");
  const group = String(food?.group || "");
  if (WHOLE_GROUPS.has(group)) return "whole";
  if (!PLAIN_BREAD_GROUPS.has(group) && WHOLE_BY_NAME.test(name)) return "whole";
  if (group === "ausnut-249" && PROTEIN_SALAD.test(name)) return "whole";
  if (NEEDS_STARCH_BY_NAME.test(name) || NEEDS_STARCH_GROUPS.has(group)) return "needs_starch";
  // Live review, 2026-11-20: any other vegetable dish (a garden salad, a
  // stuffed mushroom, a zucchini fritter) was planned like a steak, with a
  // starch and a green vegetable. It is a side, not a main.
  if (group === "ausnut-249") return null;
  if (meal === "breakfast") {
    if (CEREAL_GROUPS.has(group)) return "cereal";
    if (TOAST_GROUPS.has(group)) return "toast";
    if (EGG_GROUPS.has(group)) return "eggs";
    return "toast";
  }
  // Lunch and dinner: plain protein (and eggs) is meat and veg; so is anything else.
  return "meat_and_veg";
};

const kindOf = (food) => String(food?.name || "").split(",")[0].trim().toLowerCase();
const nameHas = (re) => (food) => re.test(String(food?.name || ""));

// P2, 2026-11-20: the side slots of each shape (BUILD_BRIEF P2 step 2). A slot
// takes foods from its groups; `only` narrows a group to some foods by name.
// `sameGroupOk` lets a green vegetable follow a starchy one (both count as
// vegetable serves), which is the survey's "meat and three veg".
const FRUIT = groups(range(161, 168));
const GREEN = groups(242, range(244, 249));
const slot = (name, required, codes, extra = {}) => Object.freeze({ name, required, groups: codes, ...extra });

// Live review, 2026-11-20: "Stir-fry + injera" and "Curry + tortilla" came
// up. Of the flat breads (123) only those eaten with a curry or a stew count.
const STARCH_FOR_CURRY = slot("starch", true, groups(121, 124, 123, 241), {
  only: (food) => food.group !== "ausnut-123" || /\b(naan|roti|paratha|chapati|pita|turkish)\b/i.test(food.name || ""),
});
const GREEN_OPTIONAL = slot("green", false, GREEN, { sameGroupOk: true });
// 243 holds root vegetables; only sweet potato and pumpkin stand in for a starch.
const STARCH_FOR_MEAT = slot("starch", true, groups(241, 121, 124, 122, 123, 243), {
  only: (food) => food.group !== "ausnut-243" || /sweet potato|pumpkin/i.test(food.name || ""),
});
const GREEN_REQUIRED = slot("green", true, GREEN, { sameGroupOk: true });
const BREAD_TOPPING = slot("topping", true, groups(171, 172, 194, 246, 247, 248, 252), {
  only: (food) => {
    const name = String(food.name || "");
    if (food.group === "ausnut-247") return /avocado/i.test(name);
    if (food.group === "ausnut-248") return /mushroom/i.test(name);
    if (food.group === "ausnut-252") return /baked beans/i.test(name);
    return true;
  },
});
const PANCAKE_TOPPING = slot("topping", true, groups(range(161, 168), 192));
const FRUIT_OPTIONAL = slot("fruit", false, FRUIT);
const EGG_VEG = slot("veg", false, groups(246, 244, 248), {
  only: (food) => {
    const kind = kindOf(food);
    if (food.group === "ausnut-246") return kind === "tomato";
    if (food.group === "ausnut-244") return kind === "spinach";
    return kind === "mushroom";
  },
});

const WHOLE_OPTIONAL = Object.freeze({
  breakfast: slot("fruit", false, FRUIT),
  lunch: slot("side", false, groups(242, 244, 246, 247, 248, 249, range(161, 167), 192)),
  dinner: slot("side", false, GREEN),
  soup: slot("bread", false, groups(122, 123)),
});

/**
 * The side slots for a main in a meal, required ones first.
 * @returns {ReadonlyArray<{ name: string, required: boolean, groups: Set<string>, only?: Function, sameGroupOk?: boolean }>}
 */
// iPhone test, 2026-11-22: mains now stop at 1.5 servings (plateBuilder
// MAIN_MAX_SERVINGS). For a big day (2,991 kcal, dinner ~1,050 kcal) a capped
// main and two ordinary sides could not reach the target, and 19 of 30 dinner
// cards went missing. One EXTRA side is allowed only when the main is already
// at its cap (`roomOnly`): fruit or yoghurt at lunch, a second vegetable or
// bread at dinner. Ordinary days never see it.
const EXTRA_FOR_BIG_MEALS = Object.freeze({
  lunch: slot("extra", false, groups(range(161, 167), 192), { roomOnly: true }),
  dinner: slot("extra", false, groups(GREEN, 122, 123), { roomOnly: true }),
});
const withExtra = (slots, meal) => (EXTRA_FOR_BIG_MEALS[meal] ? [...slots, EXTRA_FOR_BIG_MEALS[meal]] : slots);

export const slotsFor = (shape, main, meal) => {
  switch (shape) {
    case "whole":
      if (SOUP_GROUPS.has(main?.group)) return [WHOLE_OPTIONAL.soup];
      return WHOLE_OPTIONAL[meal] ? withExtra([WHOLE_OPTIONAL[meal]], meal) : [];
    case "needs_starch":
      return withExtra([STARCH_FOR_CURRY, GREEN_OPTIONAL], meal);
    case "meat_and_veg":
      return withExtra([STARCH_FOR_MEAT, GREEN_REQUIRED], meal);
    case "cereal":
      return DAIRY_MAIN_GROUPS.has(main?.group) || MADE_WITH_MILK.test(String(main?.name || ""))
        ? [FRUIT_OPTIONAL]
        : [slot("dairy", true, groups(191, 192, 201, 205)), FRUIT_OPTIONAL];
    case "toast":
      return main?.group === "ausnut-136" ? [PANCAKE_TOPPING, FRUIT_OPTIONAL] : [BREAD_TOPPING, FRUIT_OPTIONAL];
    case "eggs":
      return [slot("bread", true, groups(122, 123)), EGG_VEG];
    default:
      return [];
  }
};

/** Does a food fit a slot? */
export const fitsSlot = (food, s) => s.groups.has(food?.group) && (!s.only || s.only(food)) && !isWholeDish(food);
