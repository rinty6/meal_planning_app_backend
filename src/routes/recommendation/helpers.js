import { DEFAULT_DAILY_CALORIES, DEFAULT_MEAL_ALLOCATIONS, MEAL_TYPES, SAFETY_LIST_BY_MEAL } from "./constants.js";

export const normalizeWord = (value) => String(value ?? "").trim().toLowerCase();

export const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toOptionalNumber = (value) => {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const parseBool = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on", "y"].includes(normalizeWord(value));
};

export const ensureArray = (value) => {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
};

export const getMealTypeFromQuery = (queryMealType) => {
  const mealType = normalizeWord(queryMealType);
  return MEAL_TYPES.includes(mealType) ? mealType : null;
};

export const buildMealTargets = (dailyCalorieTarget) => ({
  breakfast: Math.round(dailyCalorieTarget * DEFAULT_MEAL_ALLOCATIONS.breakfast),
  lunch: Math.round(dailyCalorieTarget * DEFAULT_MEAL_ALLOCATIONS.lunch),
  dinner: Math.round(dailyCalorieTarget * DEFAULT_MEAL_ALLOCATIONS.dinner),
});

export const normalizeRecommendedItem = (mealType, item = {}, index = 0, fallbackMealTarget = 0, fallbackInsight = "") => {
  const normalizeId = (value) => {
    if (value === null || value === undefined) return "";
    return String(value).trim();
  };
  const id = String(item?.item_id || item?.id || item?.recipe_id || `${mealType}-item-${index}`);
  const foodId = normalizeId(item?.food_id || item?.id || id);
  const fatsecretFoodId = normalizeId(item?.fatsecret_food_id || "");
  const calories = Math.max(0, Math.round(toNumber(item?.calories ?? item?.cals ?? item?.serving_calories, 0)));
  const protein = Math.round(toNumber(item?.protein ?? item?.serving_protein, 0) * 10) / 10;
  const carbs = Math.round(toNumber(item?.carbs ?? item?.serving_carbs, 0) * 10) / 10;
  const fats = Math.round(toNumber(item?.fats ?? item?.serving_fats, 0) * 10) / 10;
  const grams = Math.max(20, Math.round(toNumber(item?.grams ?? item?.metric_serving_amount, 100)));
  const per100 = item?.per100
    ? {
        calories: toNumber(item.per100.calories, 0),
        protein: toNumber(item.per100.protein, 0),
        carbs: toNumber(item.per100.carbs, 0),
        fats: toNumber(item.per100.fats, 0),
      }
    : undefined;

  return {
    id,
    item_id: id,
    recipe_id: String(item?.recipe_id || ""),
    food_id: foodId,
    fatsecret_food_id: fatsecretFoodId,
    mealType,
    title: item?.title || item?.food_name || `Food Item ${index + 1}`,
    original_title: item?.original_title || item?.title || item?.food_name || `Food Item ${index + 1}`,
    canonical_title: item?.canonical_title || item?.title || item?.food_name || "",
    mapped_title: item?.mapped_title || null,
    mapped_canonical_title: item?.mapped_canonical_title || null,
    category: item?.category || null,
    calories,
    protein,
    carbs,
    fats,
    grams,
    image: item?.image || null,
    type: item?.type || "food",
    serving_id: item?.serving_id || null,
    serving_description: item?.serving_description || "100 g",
    metric_serving_amount: toNumber(item?.metric_serving_amount, 0),
    metric_serving_unit: item?.metric_serving_unit || null,
    food_type: item?.food_type || null,
    brand_name: item?.brand_name || null,
    food_url: item?.food_url || null,
    allergens: ensureArray(item?.allergens),
    preferences: ensureArray(item?.preferences),
    food_sub_categories: ensureArray(item?.food_sub_categories),
    explanation: item?.explanation || fallbackInsight || "",
    behavioral_insight: item?.behavioral_insight || fallbackInsight || "",
    score: toNumber(item?.score, 0),
    knn_distance: toNumber(item?.knn_distance, 0),
    adjusted_distance: toNumber(item?.adjusted_distance, 0),
    consumed_recently: Boolean(item?.consumed_recently),
    ml_tag: item?.ml_tag || "KNN",
    calorie_target: Math.max(0, Math.round(toNumber(item?.slot_target || item?.calorie_target, fallbackMealTarget))),
    calorie_diff_ratio: toNumber(item?.calorie_diff_ratio, 0),
    title_similarity: toNumber(item?.title_similarity, 0),
    mapping_acceptance_mode: item?.mapping_acceptance_mode || null,
    serving_fit_ratio: toNumber(item?.serving_fit_ratio, 0),
    per100,
  };
};

// NOTE: Normalize combos so the UI can render 3-item bundles consistently.
export const normalizeRecommendedCombo = (
  mealType,
  combo = {},
  index = 0,
  fallbackMealTarget = 0,
  fallbackInsight = ""
) => {
  const slotTarget = Math.max(0, Math.round(toNumber(combo?.slot_target || combo?.calorie_target, fallbackMealTarget)));
  const rawItems = ensureArray(combo?.items || combo?.combo_items || combo?.recommended_items);
  const normalizedItems = rawItems
    .map((item, itemIndex) => normalizeRecommendedItem(mealType, item, itemIndex, slotTarget, fallbackInsight))
    .filter((item) => !!item?.title);

  const totalCalories = normalizedItems.reduce((sum, item) => sum + toNumber(item?.calories, 0), 0);
  const totalProtein = normalizedItems.reduce((sum, item) => sum + toNumber(item?.protein, 0), 0);
  const totalCarbs = normalizedItems.reduce((sum, item) => sum + toNumber(item?.carbs, 0), 0);
  const totalFats = normalizedItems.reduce((sum, item) => sum + toNumber(item?.fats, 0), 0);

  const generatedTitle = `Combo: ${normalizedItems.map((item) => item.title).filter(Boolean).join(" + ") || `Meal ${index + 1}`}`;
  const title = normalizedItems.length > 0 ? generatedTitle : combo?.title || generatedTitle;

  return {
    id: String(combo?.combo_id || combo?.id || `${mealType}-combo-${index + 1}`),
    combo_id: String(combo?.combo_id || combo?.id || `${mealType}-combo-${index + 1}`),
    mealType,
    title,
    items: normalizedItems,
    total_calories: Math.round(totalCalories),
    total_protein: Math.round(totalProtein * 10) / 10,
    total_carbs: Math.round(totalCarbs * 10) / 10,
    total_fats: Math.round(totalFats * 10) / 10,
    explanation: combo?.explanation || fallbackInsight || "",
    behavioral_insight: combo?.behavioral_insight || fallbackInsight || "",
    score: toNumber(combo?.score, 0),
    ml_tag: combo?.ml_tag || "COMBO",
    slot_target: slotTarget,
  };
};

const extractRawItemsFromSlotPayload = (slotPayload = {}) => {
  const directItems = ensureArray(slotPayload?.recommended_items).filter(Boolean);
  if (directItems.length > 0) return directItems;

  if (Array.isArray(slotPayload)) return slotPayload;

  const genericItems = ensureArray(slotPayload?.items).filter(Boolean);
  if (genericItems.length > 0) return genericItems;

  const legacyCombos = ensureArray(slotPayload?.combos).filter(Boolean);
  if (legacyCombos.length > 0) {
    return legacyCombos.flatMap((combo) => ensureArray(combo?.items));
  }

  const legacyCombo = slotPayload?.combo;
  if (legacyCombo) {
    const fromItems = ensureArray(legacyCombo?.items);
    if (fromItems.length > 0) return fromItems;
    return [legacyCombo?.main, legacyCombo?.side1, legacyCombo?.side2].filter(Boolean);
  }

  return [];
};

export const buildRecommendedItemsFromSlotPayload = (mealType, slotPayload = {}, fallbackMealTarget = 0) => {
  if (!slotPayload) return [];
  const slotTarget = Math.max(0, Math.round(toNumber(slotPayload?.slot_target, fallbackMealTarget)));
  const behavioralInsight = slotPayload?.behavioral_insight || "";
  const rawItems = extractRawItemsFromSlotPayload(slotPayload);

  const normalized = rawItems
    .map((item, index) =>
      normalizeRecommendedItem(mealType, item, index, slotTarget || fallbackMealTarget, behavioralInsight)
    )
    .filter((item) => !!item?.title);

  const deduped = [];
  const seen = new Set();
  for (const item of normalized) {
    const key = `${normalizeWord(item.title)}:${item.food_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= 10) break;
  }

  return deduped;
};

export const buildRecommendedCombosFromSlotPayload = (mealType, slotPayload = {}, fallbackMealTarget = 0) => {
  if (!slotPayload) return [];
  const slotTarget = Math.max(0, Math.round(toNumber(slotPayload?.slot_target, fallbackMealTarget)));
  const behavioralInsight = slotPayload?.behavioral_insight || "";

  let source = ensureArray(slotPayload?.combos || slotPayload?.recommended_combos || slotPayload?.combo).filter(Boolean);
  if (source.length === 0 && Array.isArray(slotPayload) && Array.isArray(slotPayload?.[0]?.items)) {
    source = slotPayload;
  }
  if (source.length === 0) return [];

  const normalized = source
    .map((combo, index) => normalizeRecommendedCombo(mealType, combo, index, slotTarget, behavioralInsight))
    .filter((combo) => combo?.items?.length);

  return normalized.slice(0, 10);
};

export const getMlMealAllocations = (slotPayloadByMeal = {}, rootPayload = null) => {
  const rootWeights = rootPayload?.slot_weights;
  if (rootWeights && typeof rootWeights === "object") {
    const parsed = {
      breakfast: toNumber(rootWeights.breakfast, 0),
      lunch: toNumber(rootWeights.lunch, 0),
      dinner: toNumber(rootWeights.dinner, 0),
    };
    const total = parsed.breakfast + parsed.lunch + parsed.dinner;
    if (total > 0) {
      return {
        breakfast: parsed.breakfast / total,
        lunch: parsed.lunch / total,
        dinner: parsed.dinner / total,
      };
    }
  }
  return DEFAULT_MEAL_ALLOCATIONS;
};

const normalizeMostConsumedItem = (item = {}, fallbackMealType = "") => {
  const normalizeId = (value) => {
    if (value === null || value === undefined) return "";
    return String(value).trim();
  };

  return {
    id: normalizeId(item?.id || item?.food_id),
    food_id: normalizeId(item?.food_id || item?.id),
    fatsecret_food_id: normalizeId(item?.fatsecret_food_id),
    title: item?.title || item?.food_name || "Food Item",
    original_title: item?.original_title || item?.title || item?.food_name || "Food Item",
    canonical_title: item?.canonical_title || item?.title || item?.food_name || "Food Item",
    food_name: item?.food_name || item?.title || "Food Item",
    meal_type: item?.meal_type || fallbackMealType || "",
    count: Math.max(0, Math.round(toNumber(item?.count ?? item?.number_appearance, 0))),
    number_appearance: Math.max(0, Math.round(toNumber(item?.number_appearance ?? item?.count, 0))),
    calories:
      toOptionalNumber(item?.calories ?? item?.cals ?? item?.serving_calories ?? item?.dataset_serving_calories) === undefined
        ? undefined
        : Math.max(
            0,
            Math.round(
              toOptionalNumber(item?.calories ?? item?.cals ?? item?.serving_calories ?? item?.dataset_serving_calories) || 0
            )
          ),
    protein:
      toOptionalNumber(item?.protein ?? item?.serving_protein ?? item?.dataset_serving_protein) === undefined
        ? undefined
        : Math.round(
            (toOptionalNumber(item?.protein ?? item?.serving_protein ?? item?.dataset_serving_protein) || 0) * 10
          ) / 10,
    carbs:
      toOptionalNumber(item?.carbs ?? item?.serving_carbs ?? item?.dataset_serving_carbs) === undefined
        ? undefined
        : Math.round(
            (toOptionalNumber(item?.carbs ?? item?.serving_carbs ?? item?.dataset_serving_carbs) || 0) * 10
          ) / 10,
    fats:
      toOptionalNumber(item?.fats ?? item?.fat ?? item?.serving_fats ?? item?.dataset_serving_fats) === undefined
        ? undefined
        : Math.round(
            (toOptionalNumber(item?.fats ?? item?.fat ?? item?.serving_fats ?? item?.dataset_serving_fats) || 0) * 10
          ) / 10,
    grams:
      toOptionalNumber(item?.grams ?? item?.serving_amount ?? item?.serving_grams ?? item?.metric_serving_amount) === undefined
        ? undefined
        : Math.max(
            0,
            Math.round(
              toOptionalNumber(item?.grams ?? item?.serving_amount ?? item?.serving_grams ?? item?.metric_serving_amount) || 0
            )
          ),
    serving_id: item?.serving_id || undefined,
    serving_description: item?.serving_description || undefined,
    metric_serving_amount: toOptionalNumber(item?.metric_serving_amount ?? item?.serving_amount ?? item?.serving_grams),
    metric_serving_unit: item?.metric_serving_unit || item?.serving_unit || undefined,
    food_type: item?.food_type || null,
    brand_name: item?.brand_name || null,
    image: item?.image || null,
  };
};

export const buildMostConsumedByMeal = (slotPayloadByMeal = {}) => {
  const output = {};
  for (const mealType of MEAL_TYPES) {
    const payload = slotPayloadByMeal?.[mealType];
    output[mealType] = ensureArray(payload?.most_consumed_items)
      .map((item) => normalizeMostConsumedItem(item, mealType))
      .filter((item) => item.title);
  }
  return output;
};

export const getMostConsumedItems = (rootPayload = {}, slotPayloadByMeal = {}) => {
  const direct = ensureArray(rootPayload?.most_consumed_items)
    .map((item) => normalizeMostConsumedItem(item))
    .filter((item) => item.title);
  if (direct.length > 0) return direct;

  const byMeal = buildMostConsumedByMeal(slotPayloadByMeal);
  const seen = new Set();
  const merged = [];
  for (const mealType of MEAL_TYPES) {
    for (const item of byMeal[mealType] || []) {
      const key = normalizeWord(item.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
      if (merged.length >= 10) return merged;
    }
  }
  return merged;
};

const expandSafetyItems = (mealType, mealTarget) => {
  const combos = ensureArray(SAFETY_LIST_BY_MEAL[mealType]);
  const flattened = combos.flatMap((combo) => ensureArray(combo?.items));
  const output = [];
  for (let i = 0; i < flattened.length; i++) {
    output.push(
      normalizeRecommendedItem(
        mealType,
        {
          ...flattened[i],
          calorie_target: mealTarget,
          explanation: "Safety fallback recommendation.",
          behavioral_insight: "Safety fallback recommendation.",
          ml_tag: "Safety",
        },
        i,
        mealTarget,
        "Safety fallback recommendation."
      )
    );
  }
  if (output.length === 0) return [];
  while (output.length < 10) {
    const src = output[output.length % Math.max(1, output.length)];
    const clonedId = `${src.id}-safety-${output.length}`;
    output.push({
      ...src,
      id: clonedId,
      item_id: clonedId,
      food_id: src.food_id || clonedId,
      fatsecret_food_id: src.fatsecret_food_id || "",
    });
  }
  return output.slice(0, 10);
};

const expandSafetyCombos = (mealType, mealTarget) => {
  const combos = ensureArray(SAFETY_LIST_BY_MEAL[mealType]);
  const output = combos
    .map((combo, index) => normalizeRecommendedCombo(mealType, combo, index, mealTarget, combo?.explanation || "Safety fallback recommendation."))
    .filter((combo) => combo?.items?.length);
  return output.slice(0, 10);
};

export const makeSafetyResponse = (mealTargets, selectedMealType = null) => {
  const recommendationsByMeal = {};
  for (const mealType of MEAL_TYPES) {
    recommendationsByMeal[mealType] = expandSafetyCombos(mealType, mealTargets[mealType]);
  }

  const base = {
      recommendationsByMeal,
      recommendedByMeal: recommendationsByMeal,
    meal_calorie_targets: mealTargets,
    meal_allocations: DEFAULT_MEAL_ALLOCATIONS,
    daily_calorie_target:
      Object.values(mealTargets).reduce((sum, value) => sum + value, 0) || DEFAULT_DAILY_CALORIES,
    explanation: "Using safety list fallback recommendations.",
    used_safety_fallback: true,
    most_consumed_items: [],
    most_consumed_by_meal: { breakfast: [], lunch: [], dinner: [] },
  };

  if (!selectedMealType) return base;
  return {
    ...base,
    recommended: recommendationsByMeal[selectedMealType] || [],
    meal_calorie_target: mealTargets[selectedMealType],
  };
};
