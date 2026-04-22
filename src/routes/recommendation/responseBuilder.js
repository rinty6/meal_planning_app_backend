import { DEFAULT_DAILY_CALORIES, MEAL_TYPES } from "./constants.js";
import { summarizeRawMlSlotPayload } from "./dataAccess.js";
import {
  buildMealTargets,
  buildMostConsumedByMeal,
  buildRecommendedCombosFromSlotPayload,
  buildRecommendedItemsFromSlotPayload,
  ensureArray,
  getMlMealAllocations,
  getMostConsumedItems,
  makeSafetyResponse,
  toNumber,
} from "./helpers.js";

export const getFirstValidMlPayload = (payloadByMeal = {}, mealTypes = MEAL_TYPES) =>
  mealTypes.map((mealType) => payloadByMeal?.[mealType]).find((payload) => payload && typeof payload === "object");

export const extractSlotPayloadByMeal = (mlResponse = {}, selectedMealType = null) => {
  if (!mlResponse || typeof mlResponse !== "object") return {};

  if (selectedMealType) {
    return { [selectedMealType]: mlResponse };
  }

  const byMeal = mlResponse?.recommendationsByMeal;
  if (byMeal && typeof byMeal === "object") {
    const output = {};
    for (const mealType of MEAL_TYPES) {
      const payload = byMeal[mealType];
      if (payload && typeof payload === "object") {
        output[mealType] = payload;
      } else if (Array.isArray(payload)) {
        output[mealType] = { slot: mealType, recommended_items: payload };
      } else {
        output[mealType] = null;
      }
    }
    return output;
  }

  const output = {};
  for (const mealType of MEAL_TYPES) {
    const rawItems = ensureArray(mlResponse?.[mealType]);
    output[mealType] = rawItems.length > 0 ? { slot: mealType, recommended_items: rawItems } : null;
  }
  return output;
};

export const summarizeFinalSlotOutput = (entries = []) => {
  const normalizedEntries = ensureArray(entries).filter(Boolean);
  const finalComboCount = normalizedEntries.filter((entry) => ensureArray(entry?.items).length > 0).length;
  const finalItemCount = normalizedEntries.reduce((sum, entry) => {
    const nestedItems = ensureArray(entry?.items).filter(Boolean);
    return sum + (nestedItems.length > 0 ? nestedItems.length : 1);
  }, 0);

  return {
    finalEntryCount: normalizedEntries.length,
    finalComboCount,
    finalItemCount,
  };
};

export const buildRecommendationResponsePayload = ({
  selectedMealType = null,
  dailyCalorieTarget = DEFAULT_DAILY_CALORIES,
  forceExploration = false,
  mlResponsePayload = null,
} = {}) => {
  const mealTypesToRequest = selectedMealType ? [selectedMealType] : MEAL_TYPES;
  const mlPayloadByMeal = extractSlotPayloadByMeal(mlResponsePayload, selectedMealType);
  const firstPayload = getFirstValidMlPayload(mlPayloadByMeal, mealTypesToRequest);

  let normalizedDailyCalorieTarget = Math.max(1200, toNumber(dailyCalorieTarget, DEFAULT_DAILY_CALORIES));
  let mealTargets = buildMealTargets(normalizedDailyCalorieTarget);

  const payloadDailyCalorieTarget =
    toNumber(mlResponsePayload?.daily_calorie_target, 0) || toNumber(firstPayload?.daily_calorie_target, 0);
  if (payloadDailyCalorieTarget > 0) {
    normalizedDailyCalorieTarget = Math.max(1200, Math.round(payloadDailyCalorieTarget));
    mealTargets = buildMealTargets(normalizedDailyCalorieTarget);
  }

  const transformStartedAt = Date.now();
  const recommendationsByMeal = { breakfast: [], lunch: [], dinner: [] };
  for (const mealType of mealTypesToRequest) {
    const slotPayload = mlPayloadByMeal?.[mealType];
    if (!slotPayload || typeof slotPayload !== "object") continue;

    const slotTarget = Math.max(0, Math.round(toNumber(slotPayload?.slot_target, mealTargets[mealType])));
    if (slotTarget > 0) mealTargets[mealType] = slotTarget;

    const combos = buildRecommendedCombosFromSlotPayload(mealType, slotPayload, mealTargets[mealType]);
    recommendationsByMeal[mealType] =
      combos.length > 0
        ? combos
        : buildRecommendedItemsFromSlotPayload(mealType, slotPayload, mealTargets[mealType]);
  }

  const hasAnyRecommendation = MEAL_TYPES.some(
    (mealType) => ensureArray(recommendationsByMeal[mealType]).length > 0
  );
  const finalRecommendationsByMeal = hasAnyRecommendation
    ? recommendationsByMeal
    : makeSafetyResponse(mealTargets).recommendationsByMeal;

  const usedSafetyFallback = !hasAnyRecommendation;
  const mostConsumedByMeal = hasAnyRecommendation
    ? buildMostConsumedByMeal(mlPayloadByMeal)
    : { breakfast: [], lunch: [], dinner: [] };
  const mostConsumedItems = hasAnyRecommendation
    ? getMostConsumedItems(mlResponsePayload, mlPayloadByMeal)
    : [];

  const responseBase = {
    recommendationsByMeal: finalRecommendationsByMeal,
    recommendedByMeal: finalRecommendationsByMeal,
    meal_calorie_targets: mealTargets,
    meal_allocations: getMlMealAllocations(mlPayloadByMeal, mlResponsePayload),
    daily_calorie_target: normalizedDailyCalorieTarget,
    explanation: hasAnyRecommendation ? "" : "Using safety list fallback recommendations.",
    used_safety_fallback: usedSafetyFallback,
    force_exploration_used: forceExploration,
    most_consumed_items: mostConsumedItems,
    most_consumed_by_meal: mostConsumedByMeal,
    model_metrics: mlResponsePayload?.model_metrics || {},
  };
  const responseTransformMs = Date.now() - transformStartedAt;

  const slotTimingMs = {};
  const slotCountComparison = {};
  for (const mealType of mealTypesToRequest) {
    const timing =
      responseBase.model_metrics?.slots?.[mealType]?.timing || mlPayloadByMeal?.[mealType]?.model_metrics?.timing;
    if (timing && typeof timing === "object") {
      slotTimingMs[mealType] = {
        slotTotalMs: toNumber(timing?.slot_total_ms, 0),
        retrievalMs: toNumber(timing?.retrieval_ms, 0),
        mappingMs: toNumber(timing?.mapping_ms, 0),
        rankingMs: toNumber(timing?.ranking_ms, 0),
        comboAssemblyMs: toNumber(timing?.combo_assembly_ms, 0),
      };
    }

    const rawSummary = summarizeRawMlSlotPayload(
      mlPayloadByMeal?.[mealType],
      responseBase.model_metrics?.slots?.[mealType] || {}
    );
    const finalSummary = summarizeFinalSlotOutput(finalRecommendationsByMeal?.[mealType]);
    slotCountComparison[mealType] = {
      rawCombos: rawSummary.rawComboCount,
      rawItems: rawSummary.rawItemCount,
      finalEntries: finalSummary.finalEntryCount,
      finalCombos: finalSummary.finalComboCount,
      finalItems: finalSummary.finalItemCount,
      slotTarget: rawSummary.slotTarget || mealTargets[mealType] || 0,
    };
  }

  const routePayload = selectedMealType
    ? {
        ...responseBase,
        recommended: finalRecommendationsByMeal[selectedMealType] || [],
        meal_calorie_target: mealTargets[selectedMealType],
      }
    : responseBase;

  return {
    mealTypesToRequest,
    dailyCalorieTarget: normalizedDailyCalorieTarget,
    mealTargets,
    mlPayloadByMeal,
    responseBase,
    routePayload,
    responseTransformMs,
    slotTimingMs,
    slotCountComparison,
  };
};