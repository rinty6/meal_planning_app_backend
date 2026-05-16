import express from "express";

import { DEFAULT_DAILY_CALORIES, FEEDBACK_STATUSES, MEAL_TYPES } from "./recommendation/constants.js";
import {
  fetchMlRecommendations,
  getActiveCalorieGoal,
  getRecommendationFeedbackProfile,
  getUserByClerkId,
  getUserDemographics,
  getUserFavoriteTitles,
  recordRecommendationFeedback,
} from "./recommendation/dataAccess.js";
import {
  ensureArray,
  getMealTypeFromQuery,
  parseBool,
  toNumber,
} from "./recommendation/helpers.js";
import { buildRecommendationResponsePayload } from "./recommendation/responseBuilder.js";
import { enrichRecommendationImages } from "../services/mealAPI.js";
import { createTtlCache } from "../utils/ttlCache.js";

const recommendationRoutes = express.Router();
const RECOMMENDATION_DEBUG_LOGS = process.env.RECOMMENDATION_DEBUG_LOGS === "1";
const FROZEN_REPLAY_ROUTE_DISABLED = process.env.NODE_ENV === "production";

// Per-user recommendation cache. The full route response (ML output +
// FatSecret image enrichment) is reused for 5 minutes per (clerkId, mealType).
// `force_exploration` bypasses the cache so users explicitly asking for new
// suggestions never see a stale set.
const RECOMMENDATION_CACHE_TTL_MS = 5 * 60 * 1000;
const recommendationResponseCache = createTtlCache({
  ttlMs: RECOMMENDATION_CACHE_TTL_MS,
  maxEntries: 2000,
});

const buildRecommendationCacheKey = ({ clerkId, mealType }) =>
  `${clerkId}|${mealType || "all"}`;

const normalizeSnapshotMealType = (mealType) => {
  const normalizedMealType = String(mealType || "").trim().toLowerCase();
  return MEAL_TYPES.includes(normalizedMealType) ? normalizedMealType : null;
};

recommendationRoutes.get("/:clerkId", async (req, res) => {
  try {
    const routeStartedAt = Date.now();
    const { clerkId } = req.params;
    const selectedMealType = getMealTypeFromQuery(req.query.mealType);
    const forceExploration = parseBool(req.query.force_exploration) || parseBool(req.query.forceExploration);

    // Reuse the last computed payload for this user + mealType when the caller is
    // not explicitly asking for fresh exploration. The route is otherwise dominated
    // by an ML round trip plus FatSecret image enrichment.
    const cacheKey = buildRecommendationCacheKey({ clerkId, mealType: selectedMealType });
    if (!forceExploration) {
      const cached = recommendationResponseCache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
    }

    const user = await getUserByClerkId(clerkId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const [feedback, demo, calorieTarget, favoriteTitles] = await Promise.all([
      getRecommendationFeedbackProfile(user.userId, 400),
      getUserDemographics(user.userId),
      getActiveCalorieGoal(user.userId),
      getUserFavoriteTitles(user.userId, 50),
    ]);

    const mlDemographics = {
      goal: demo.goal || "maintain",
      weight: demo.weight || null,
      height: demo.height || null,
      dateOfBirth: demo.dateOfBirth || null,
      gender: demo.gender || "male",
      activityLevel: demo.activityLevel || "moderately_active",
    };

    let mlResponsePayload = null;
    let mlElapsedMs = 0;
    try {
      const mlStartedAt = Date.now();
      mlResponsePayload = await fetchMlRecommendations({
        userId: user.userId,
        mealType: selectedMealType || "all",
        calorieTarget,
        forceExploration,
        demographics: mlDemographics,
        feedback,
        favoriteTitles,
      });
      mlElapsedMs = Date.now() - mlStartedAt;
    } catch {
      mlResponsePayload = null;
    }

    // Share route response assembly with frozen-input harnesses so release checks cannot drift from live normalization.
    const builtResponse = buildRecommendationResponsePayload({
      selectedMealType,
      dailyCalorieTarget: calorieTarget,
      forceExploration,
      mlResponsePayload,
    });
    const {
      mealTypesToRequest: responseMealTypes,
      mlPayloadByMeal,
      responseBase,
      routePayload,
      responseTransformMs,
      slotTimingMs,
      slotCountComparison,
    } = builtResponse;

    if (RECOMMENDATION_DEBUG_LOGS) {
      console.log("[recommendation.js] response summary:", {
        routeElapsedMs: Date.now() - routeStartedAt,
        mlElapsedMs,
        responseTransformMs,
        dailyCalorieTarget: responseBase.daily_calorie_target,
        itemsCount: {
          breakfast: ensureArray(responseBase.recommendationsByMeal.breakfast).length,
          lunch: ensureArray(responseBase.recommendationsByMeal.lunch).length,
          dinner: ensureArray(responseBase.recommendationsByMeal.dinner).length,
        },
        usedSafetyFallback: responseBase.used_safety_fallback,
        slotCountComparison,
        slotTimingMs,
      });
      for (const mealType of responseMealTypes) {
        const items = ensureArray(responseBase.recommendationsByMeal?.[mealType]).slice(0, 3);
        items.forEach((item, idx) => {
          const firstItem = ensureArray(item?.items)[0];
          console.log(
            `[recommendation.js] ${mealType} #${idx + 1}: ${item?.title || firstItem?.title} ` +
              `score=${toNumber(item?.score, 0).toFixed(4)} ` +
              `knn=${toNumber(firstItem?.knn_distance, 0).toFixed(4)} ` +
              `adj=${toNumber(firstItem?.adjusted_distance, 0).toFixed(4)}`
          );
        });
      }
    }

    // Backfill missing image URLs via FatSecret search (cached). off.db has no image column, so combos arrive imageless.
    try {
      await enrichRecommendationImages(routePayload?.recommendationsByMeal);
    } catch (enrichError) {
      console.warn("Recommendation image enrichment failed (non-fatal):", enrichError?.message || enrichError);
    }

    // Cache the final enriched payload so the next hit within the TTL skips the
    // ML round trip and the FatSecret enrichment entirely. Exploration requests
    // never write to the cache (the user asked for fresh output).
    if (!forceExploration) {
      recommendationResponseCache.set(cacheKey, routePayload);
    }

    return res.json(routePayload);
  } catch (error) {
    console.error("Recommendation Route Error:", error);
    return res.status(500).json({ error: "Recommendation failed" });
  }
});

recommendationRoutes.post("/__frozen/replay", async (req, res) => {
  try {
    if (FROZEN_REPLAY_ROUTE_DISABLED) {
      return res.status(404).json({ error: "Not found" });
    }

    const snapshotPayload = req.body && typeof req.body === "object" ? req.body : {};
    const selectedMealType = normalizeSnapshotMealType(snapshotPayload?.mealType);
    const forceExploration = parseBool(snapshotPayload?.force_exploration) || parseBool(snapshotPayload?.forceExploration);

    const mlStartedAt = Date.now();
    const mlResponsePayload = await fetchMlRecommendations({
      userId: snapshotPayload?.userId,
      mealType: selectedMealType || "all",
      calorieTarget: snapshotPayload?.calorieTarget,
      forceExploration,
      demographics: snapshotPayload?.demographics || {},
      feedback: snapshotPayload?.feedback || {},
      favoriteTitles: ensureArray(snapshotPayload?.favorite_titles),
    });
    const mlElapsedMs = Date.now() - mlStartedAt;

    // Allow a frozen snapshot to exercise the HTTP route path without reading drifting live user state.
    const builtResponse = buildRecommendationResponsePayload({
      selectedMealType,
      dailyCalorieTarget: snapshotPayload?.calorieTarget,
      forceExploration,
      mlResponsePayload,
    });

    if (RECOMMENDATION_DEBUG_LOGS) {
      console.log("[recommendation.js] frozen replay summary:", {
        mlElapsedMs,
        responseTransformMs: builtResponse.responseTransformMs,
        usedSafetyFallback: builtResponse.responseBase.used_safety_fallback,
        mealCounts: {
          breakfast: ensureArray(builtResponse.responseBase.recommendationsByMeal.breakfast).length,
          lunch: ensureArray(builtResponse.responseBase.recommendationsByMeal.lunch).length,
          dinner: ensureArray(builtResponse.responseBase.recommendationsByMeal.dinner).length,
        },
      });
    }

    return res.json({
      ...builtResponse.routePayload,
      replay_meta: {
        mode: "frozen_snapshot_http_replay",
        ml_request_ms: mlElapsedMs,
        response_transform_ms: builtResponse.responseTransformMs,
      },
    });
  } catch (error) {
    console.error("Recommendation frozen replay route error:", error);
    return res.status(500).json({ error: "Frozen replay failed" });
  }
});

recommendationRoutes.post("/feedback", async (req, res) => {
  try {
    const { clerkId, comboId, mealType, status, ml_tag, explanation, itemTitle, itemTitles } = req.body || {};
    const normalizedStatus = String(status || "").trim();
    const normalizedMealType = String(mealType || "").trim().toLowerCase();
    if (!clerkId || !comboId || !FEEDBACK_STATUSES.has(normalizedStatus)) {
      return res.status(400).json({ error: "Missing or invalid feedback payload." });
    }

    const user = await getUserByClerkId(clerkId);
    if (!user) return res.status(404).json({ error: "User not found" });

    await recordRecommendationFeedback({
      userId: user.userId,
      clerkId,
      comboId: String(comboId),
      mealType: MEAL_TYPES.includes(normalizedMealType) ? normalizedMealType : "unknown",
      status: normalizedStatus,
      ml_tag: ml_tag || null,
      explanation: explanation || null,
      itemTitles: ensureArray(itemTitles || itemTitle).filter(Boolean),
    });
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Recommendation feedback error:", error);
    return res.status(500).json({ error: "Failed to store recommendation feedback" });
  }
});

export default recommendationRoutes;
