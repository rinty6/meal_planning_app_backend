import fetch from "node-fetch";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";

import { db } from "../../config/db.js";
import {
  calorieGoalsTable,
  demographicsTable,
  favouritesTable,
  mealLogsTable,
  recommendationFeedbackTable,
  usersTable,
} from "../../db/schema.js";
import { ML_PRIME_URL, ML_URL } from "./constants.js";

const PRIME_TTL_MS = 5 * 60 * 1000;
const ML_PRIME_REQUEST_TIMEOUT_MS = 10000;
const ML_PRIME_UNAVAILABLE_COOLDOWN_MS = 30 * 1000;
const ML_PRIME_CONNECTION_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ETIMEDOUT"]);
const primedUsers = new Map();
const primingUsers = new Set();
const RECOMMENDATION_DEBUG_LOGS = process.env.RECOMMENDATION_DEBUG_LOGS === "1";
const FEEDBACK_PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
const feedbackProfileCache = new Map();
const FEEDBACK_DECAY_LAMBDA = 0.08;
const FEEDBACK_MIN_ABS_WEIGHT = 0.03;
const FEEDBACK_MAX_ABS_WEIGHT = 0.75;
const FEEDBACK_STATUS_WEIGHTS = {
  Loved: 0.75,
  Accepted: 0.35,
  Skipped: -0.45,
  Rejected: -0.75,
};
const RECOMMENDATION_FEEDBACK_USER_CREATED_AT_INDEX = "recommendation_feedback_user_created_at_idx";
let recommendationFeedbackTableReadyPromise = null;
let recommendationFeedbackTableReadyLogged = false;
let mlPrimeUnavailableUntil = 0;

const ensureArray = (value) => {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
};

const getMlPrimeRetryAfterMs = () => Math.max(0, mlPrimeUnavailableUntil - Date.now());

const markMlPrimeUnavailable = () => {
  mlPrimeUnavailableUntil = Date.now() + ML_PRIME_UNAVAILABLE_COOLDOWN_MS;
  return ML_PRIME_UNAVAILABLE_COOLDOWN_MS;
};

const clearMlPrimeUnavailable = () => {
  mlPrimeUnavailableUntil = 0;
};

const isMlPrimeAvailabilityError = (error) => {
  if (!error) return false;
  if (error?.name === "AbortError") return true;
  if (ML_PRIME_CONNECTION_ERROR_CODES.has(String(error?.code || "").trim().toUpperCase())) return true;

  const status = Number(error?.status || 0);
  return status >= 500;
};

const normalizePrimeWaitTimeoutMs = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Math.max(0, fallback);
  return Math.max(0, Math.min(60_000, Math.round(parsed)));
};

const buildMlPrimePayload = async ({ userId, demographics, mealType = "all" }) => {
  const [calorieTarget, feedback, favoriteTitles] = await Promise.all([
    getActiveCalorieGoal(userId),
    getRecommendationFeedbackProfile(userId, 400),
    getUserFavoriteTitles(userId, 50),
  ]);

  return {
    userId,
    mealType: mealType || "all",
    calorieTarget: calorieTarget ?? null,
    force_exploration: false,
    demographics,
    feedback: feedback || {},
    favorite_titles: favoriteTitles || [],
  };
};

const postMlPrimeRequest = async ({ payload, timeoutMs, endpoint = ML_PRIME_URL }) => {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), Math.max(0, timeoutMs || 0));
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify(payload),
    });

    let responsePayload = null;
    try {
      responsePayload = await response.json();
    } catch {
      responsePayload = null;
    }

    if (!response.ok) {
      const error = new Error(`ML prime failed with status ${response.status}`);
      error.status = response.status;
      error.payload = responsePayload;
      throw error;
    }

    return responsePayload || {};
  } finally {
    clearTimeout(timeoutId);
  }
};

const normalizeMlPrimeResponse = (payload = {}, fallback = {}) => {
  const warmup = payload?.recommendation_warmup && typeof payload.recommendation_warmup === "object"
    ? payload.recommendation_warmup
    : payload;

  return {
    queued: !!warmup?.queued,
    reason: warmup?.reason || fallback.reason || "unknown",
    retryAfterMs: Number(warmup?.retryAfterMs || payload?.retryAfterMs || fallback.retryAfterMs || 0),
    warmed: !!warmup?.warmed,
    warming: !!warmup?.warming,
    waited: !!warmup?.waited,
    waitedMs: Number(warmup?.waited_ms || warmup?.waitedMs || 0),
    waitTimeoutMs: Number(warmup?.wait_timeout_ms || warmup?.waitTimeoutMs || 0),
    waitTimedOut: !!(warmup?.wait_timed_out || warmup?.waitTimedOut),
    mealType: warmup?.meal_type || payload?.meal_type || fallback.mealType || "all",
    primedHistory: !!payload?.primed_history,
    profileCounts: payload?.profile_counts || {},
  };
};

export const summarizeRawMlSlotPayload = (slotPayload = {}, aggregateSlotMetrics = {}) => {
  if (!slotPayload || typeof slotPayload !== "object" || Array.isArray(slotPayload)) {
    return {
      rawComboCount: Array.isArray(slotPayload) ? slotPayload.length : 0,
      rawItemCount: 0,
      slotTarget: 0,
      timing: null,
    };
  }

  const timing = slotPayload?.model_metrics?.timing || aggregateSlotMetrics?.timing || {};
  return {
    rawComboCount: ensureArray(slotPayload?.combos || slotPayload?.recommended_combos || slotPayload?.combo).filter(Boolean)
      .length,
    rawItemCount: ensureArray(slotPayload?.recommended_items || slotPayload?.items).filter(Boolean).length,
    slotTarget: Number(slotPayload?.slot_target || 0),
    timing:
      timing && typeof timing === "object"
        ? {
            slotTotalMs: Number(timing?.slot_total_ms || 0),
            retrievalMs: Number(timing?.retrieval_ms || 0),
            mappingMs: Number(timing?.mapping_ms || 0),
            rankingMs: Number(timing?.ranking_ms || 0),
            comboAssemblyMs: Number(timing?.combo_assembly_ms || 0),
          }
        : null,
  };
};

const normalizeWhitespace = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const stripTitleWrappers = (value) =>
  normalizeWhitespace(String(value ?? "").replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " "));

const stripBrandPrefix = (value) => {
  let text = normalizeWhitespace(value);
  if (!text) return "";
  if (text.includes(",")) {
    text = text.split(",", 2)[1]?.trim() || text;
  } else if (text.includes(" - ")) {
    text = text.split(" - ", 2)[1]?.trim() || text;
  } else if (text.includes(":")) {
    text = text.split(":", 2)[1]?.trim() || text;
  }
  return normalizeWhitespace(text);
};

const canonicalizeTitle = (value) => {
  const cleaned = normalizeWhitespace(value);
  if (!cleaned) return "";
  return normalizeWhitespace(stripBrandPrefix(stripTitleWrappers(cleaned)).replace(/[_/]+/g, " ")) || cleaned;
};

const canonicalTitleKey = (value) => canonicalizeTitle(value).toLowerCase();

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const getFeedbackProfileCacheKey = (userId, limit) => `${String(userId ?? "").trim()}:${Math.max(1, Number(limit) || 400)}`;

const getCachedFeedbackProfile = (userId, limit) => {
  const cacheKey = getFeedbackProfileCacheKey(userId, limit);
  const cached = feedbackProfileCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    feedbackProfileCache.delete(cacheKey);
    return null;
  }
  return cached.value;
};

const setCachedFeedbackProfile = (userId, limit, value) => {
  const cacheKey = getFeedbackProfileCacheKey(userId, limit);
  feedbackProfileCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + FEEDBACK_PROFILE_CACHE_TTL_MS,
  });
  return value;
};

const invalidateCachedFeedbackProfiles = (userId) => {
  const prefix = `${String(userId ?? "").trim()}:`;
  for (const cacheKey of feedbackProfileCache.keys()) {
    if (cacheKey.startsWith(prefix)) {
      feedbackProfileCache.delete(cacheKey);
    }
  }
};

const ensureRecommendationFeedbackTable = async () => {
  if (!recommendationFeedbackTableReadyPromise) {
    recommendationFeedbackTableReadyPromise = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "recommendation_feedback" (
          "id" serial PRIMARY KEY NOT NULL,
          "user_id" integer NOT NULL REFERENCES "public"."user_info"("id") ON DELETE cascade ON UPDATE no action,
          "clerk_id" text,
          "combo_id" text NOT NULL,
          "meal_type" text NOT NULL,
          "status" text NOT NULL,
          "ml_tag" text,
          "explanation" text,
          "item_titles" jsonb DEFAULT '[]'::jsonb NOT NULL,
          "created_at" timestamp DEFAULT now() NOT NULL
        );
      `);

      await db.execute(sql.raw(
        `CREATE INDEX IF NOT EXISTS "${RECOMMENDATION_FEEDBACK_USER_CREATED_AT_INDEX}" ON "recommendation_feedback" USING btree ("user_id","created_at")`
      ));

        if (!recommendationFeedbackTableReadyLogged) {
          console.log("[dataAccess.js] recommendation_feedback table is ready");
          recommendationFeedbackTableReadyLogged = true;
        }
    })()
      .catch((error) => {
        recommendationFeedbackTableReadyPromise = null;
        throw error;
      });
  }

  return recommendationFeedbackTableReadyPromise;
};

export const ensureRecommendationFeedbackStorage = async () => {
  await ensureRecommendationFeedbackTable();
};

export const warmRecommendationRouteDependencies = async () => {
  // Touching every table the app reads on first focus warms the Drizzle ORM
  // metadata + the Postgres connection pool for those tables. Without this,
  // the FIRST request that hits a previously-untouched table on a fresh
  // Railway container can stall for several seconds (see Error 016 follow-up:
  // /api/meals/summary spent ~5 s on cold first hit even though the route is
  // a single SELECT).
  const warmupTasks = [
    ensureRecommendationFeedbackTable(),
    db.execute(sql`SELECT 1`),
    db.select({ userId: usersTable.userId }).from(usersTable).limit(1),
    db.select({ userId: demographicsTable.userId }).from(demographicsTable).limit(1),
    db.select({ userId: calorieGoalsTable.userId }).from(calorieGoalsTable).limit(1),
    db.select({ userId: favouritesTable.userId }).from(favouritesTable).limit(1),
    db.select({ userId: mealLogsTable.userId }).from(mealLogsTable).limit(1),
  ];

  const results = await Promise.allSettled(warmupTasks);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new Error(`recommendation route warmup failed for ${failures.length} task(s)`);
  }

  console.log("[dataAccess.js] recommendation route dependencies warmed");
};

const buildFeedbackProfile = (rows = []) => {
  const skippedTitles = new Set();
  const lovedTitles = new Set();
  const titleBias = {};
  const now = Date.now();

  for (const row of rows) {
    const status = String(row?.status || "").trim();
    const statusWeight = Number(FEEDBACK_STATUS_WEIGHTS[status] || 0);
    if (!statusWeight) continue;

    const createdAtMs = row?.createdAt ? new Date(row.createdAt).getTime() : now;
    const ageDays = Math.max(0, (now - createdAtMs) / (1000 * 60 * 60 * 24));
    const decay = Math.exp(-FEEDBACK_DECAY_LAMBDA * ageDays);

    for (const title of ensureArray(row?.itemTitles)) {
      const key = canonicalTitleKey(title);
      if (!key) continue;
      const nextWeight = clamp((titleBias[key] || 0) + statusWeight * decay, -FEEDBACK_MAX_ABS_WEIGHT, FEEDBACK_MAX_ABS_WEIGHT);
      titleBias[key] = nextWeight;
    }
  }

  const filteredBias = {};
  for (const [title, weight] of Object.entries(titleBias)) {
    if (Math.abs(weight) < FEEDBACK_MIN_ABS_WEIGHT) continue;
    filteredBias[title] = Number(weight.toFixed(4));
    if (weight <= -0.15) skippedTitles.add(title);
    if (weight >= 0.15) lovedTitles.add(title);
  }

  return {
    skipped_titles: Array.from(skippedTitles),
    loved_titles: Array.from(lovedTitles),
    title_bias: filteredBias,
    recent_feedback_count: rows.length,
  };
};

export const getUserByClerkId = async (clerkId) => {
  const users = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId)).limit(1);
  return users.length > 0 ? users[0] : null;
};

export const getUserDemographics = async (userId) => {
  const demos = await db.select().from(demographicsTable).where(eq(demographicsTable.userId, userId)).limit(1);
  return demos[0] || {};
};

export const getActiveCalorieGoal = async (userId) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const goals = await db
      .select()
      .from(calorieGoalsTable)
      .where(
        and(
          eq(calorieGoalsTable.userId, userId),
          lte(calorieGoalsTable.startDate, today),
          gte(calorieGoalsTable.endDate, today)
        )
      )
      .orderBy(desc(calorieGoalsTable.createdAt))
      .limit(1);

    return goals.length > 0 ? goals[0].dailyCalories : null;
  } catch {
    return null;
  }
};

export const getUserFavoriteTitles = async (userId, limit = 50) => {
  // NOTE: Favorites serve as "love" signals for ML ranking.
  try {
    const favorites = await db
      .select({ title: favouritesTable.title })
      .from(favouritesTable)
      .where(eq(favouritesTable.userId, userId))
      .limit(limit);
    return favorites.map((row) => row?.title).filter(Boolean);
  } catch {
    return [];
  }
};

export const getRecommendationFeedbackProfile = async (userId, limit = 400) => {
  try {
    const cached = getCachedFeedbackProfile(userId, limit);
    if (cached) return cached;

    await ensureRecommendationFeedbackTable();
    const rows = await db
      .select({
        status: recommendationFeedbackTable.status,
        itemTitles: recommendationFeedbackTable.itemTitles,
        createdAt: recommendationFeedbackTable.createdAt,
      })
      .from(recommendationFeedbackTable)
      .where(eq(recommendationFeedbackTable.userId, userId))
      .orderBy(desc(recommendationFeedbackTable.createdAt))
      .limit(limit);

    return setCachedFeedbackProfile(userId, limit, buildFeedbackProfile(rows));
  } catch {
    return {
      skipped_titles: [],
      loved_titles: [],
      title_bias: {},
      recent_feedback_count: 0,
    };
  }
};

export const recordRecommendationFeedback = async ({
  userId,
  clerkId,
  comboId,
  mealType,
  status,
  ml_tag,
  explanation,
  itemTitles,
}) => {
  await ensureRecommendationFeedbackTable();

  const normalizedTitles = ensureArray(itemTitles)
    .map((title) => normalizeWhitespace(title))
    .filter(Boolean);

  await db.insert(recommendationFeedbackTable).values({
    userId,
    clerkId: clerkId || null,
    comboId: String(comboId || "").trim(),
    mealType: String(mealType || "unknown").trim().toLowerCase(),
    status: String(status || "").trim(),
    mlTag: ml_tag || null,
    explanation: explanation || null,
    itemTitles: normalizedTitles,
  });

  invalidateCachedFeedbackProfiles(userId);
};

export const fetchMlRecommendations = async ({
  userId,
  mealType,
  calorieTarget,
  forceExploration,
  demographics,
  feedback,
  favoriteTitles,
}) => {
  if (RECOMMENDATION_DEBUG_LOGS) {
    console.log("\n" + "=".repeat(60));
    console.log("[dataAccess.js] 🔵 SENDING REQUEST TO ML SERVICE:");
    console.log(`  URL: ${ML_URL}`);
    console.log(`  User ID: ${userId}`);
    console.log(`  Meal Type: ${mealType}`);
    console.log(`  Calorie Target: ${calorieTarget}`);
    console.log(`  Force Exploration: ${forceExploration}`);
    console.log(`  Demographics: ${JSON.stringify(demographics)}`);
    console.log("=".repeat(60) + "\n");
  }

  const requestStartedAt = Date.now();

  const mlResponse = await fetch(ML_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId,
      mealType: mealType || "all",
      calorieTarget: calorieTarget || null,
      force_exploration: forceExploration,
      demographics,
      feedback: feedback || {},
      favorite_titles: favoriteTitles || [],
    }),
  });

  if (!mlResponse.ok) {
    console.error(`[dataAccess.js] ❌ ML Service Error: ${mlResponse.status}`);
    console.error(`[dataAccess.js] ML request duration: ${Date.now() - requestStartedAt}ms`);
    return null;
  }

  const payload = await mlResponse.json();
  const elapsedMs = Date.now() - requestStartedAt;
  
  if (RECOMMENDATION_DEBUG_LOGS) {
    console.log("\n" + "=".repeat(60));
    console.log("[dataAccess.js] 🟢 ML SERVICE RESPONSE RECEIVED:");
    if (payload && typeof payload === "object") {
      console.log(`  Keys: ${Object.keys(payload).join(", ")}`);
      if (payload.recommendationsByMeal) {
        console.log(`  Recommendations by Meal: ${Object.keys(payload.recommendationsByMeal).join(", ")}`);
        for (const [meal, slotPayload] of Object.entries(payload.recommendationsByMeal || {})) {
          const rawSummary = summarizeRawMlSlotPayload(slotPayload, payload?.model_metrics?.slots?.[meal] || {});
          if (slotPayload && typeof slotPayload === "object" && !Array.isArray(slotPayload)) {
            console.log(
              `    ${meal}: raw_slot combos=${rawSummary.rawComboCount} ` +
                `recommended_items=${rawSummary.rawItemCount} ` +
                `slot_target=${rawSummary.slotTarget}`
            );
            if (rawSummary.timing) {
              console.log(`      timing_ms=${JSON.stringify(rawSummary.timing)}`);
            }
          } else {
            console.log(`    ${meal}: final_array entries=${rawSummary.rawComboCount}`);
          }
        }
      }
      console.log(`  Daily Calorie Target: ${payload.daily_calorie_target}`);
      console.log(`  Request Duration: ${elapsedMs}ms`);
      if (payload?.model_metrics?.overall_timing) {
        console.log(`  Overall Slot Timing: ${JSON.stringify(payload.model_metrics.overall_timing)}`);
      }
      console.log(`  Full Payload: ${JSON.stringify(payload).substring(0, 500)}...`);
    }
    console.log("=".repeat(60) + "\n");
  }

  if (!payload || typeof payload !== "object") return null;
  return payload;
};

export const primeMlContext = ({ userId, demographics }) => {
  const rawUserId = userId;
  const normalizedUserId = String(userId || "").trim();
  const resolvedUserId = Number.isFinite(Number(normalizedUserId)) ? Number(normalizedUserId) : rawUserId;
  if (!normalizedUserId) {
    return { queued: false, reason: "missing_user_id" };
  }

  const lastPrimedAt = Number(primedUsers.get(normalizedUserId) || 0);
  const now = Date.now();
  if (primingUsers.has(normalizedUserId)) {
    return { queued: false, reason: "already_priming" };
  }

  if (now - lastPrimedAt < PRIME_TTL_MS) {
    return {
      queued: false,
      reason: "ttl_active",
      retryAfterMs: Math.max(0, PRIME_TTL_MS - (now - lastPrimedAt)),
    };
  }

  const retryAfterMs = getMlPrimeRetryAfterMs();
  if (retryAfterMs > 0) {
    return {
      queued: false,
      reason: "ml_service_unavailable",
      retryAfterMs,
    };
  }

  primedUsers.set(normalizedUserId, now);
  primingUsers.add(normalizedUserId);
  const requestStartedAt = Date.now();
  // NOTE: Fire-and-forget cache warm-up to avoid blocking login or recommendations.
  void (async () => {
    try {
      const primePayload = await buildMlPrimePayload({
        userId: resolvedUserId,
        demographics,
        mealType: "all",
      });
      await postMlPrimeRequest({
        payload: primePayload,
        timeoutMs: ML_PRIME_REQUEST_TIMEOUT_MS,
      });

      clearMlPrimeUnavailable();
      console.log("[dataAccess.js] ML prime request completed", {
        userId: normalizedUserId,
        ttlMs: PRIME_TTL_MS,
        elapsedMs: Date.now() - requestStartedAt,
      });
    } catch (error) {
      primedUsers.delete(normalizedUserId);
      if (isMlPrimeAvailabilityError(error)) {
        const cooldownMs = markMlPrimeUnavailable();
        console.warn("[dataAccess.js] ML prime skipped; ML service unavailable", {
          userId: normalizedUserId,
          code: error?.code || error?.name || null,
          status: Number(error?.status || 0) || null,
          retryAfterMs: cooldownMs,
        });
        return;
      }

      console.error("[dataAccess.js] ML prime error:", error);
    } finally {
      primingUsers.delete(normalizedUserId);
    }
  })().catch((error) => {
    primedUsers.delete(normalizedUserId);
    primingUsers.delete(normalizedUserId);
    console.error("[dataAccess.js] ML prime preparation error:", error);
  });

  return { queued: true, reason: "queued", ttlMs: PRIME_TTL_MS };
};

export const primeMlContextAndWait = async ({ userId, demographics, mealType = "all", waitTimeoutMs = 0 }) => {
  const rawUserId = userId;
  const normalizedUserId = String(userId || "").trim();
  const resolvedUserId = Number.isFinite(Number(normalizedUserId)) ? Number(normalizedUserId) : rawUserId;
  const normalizedWaitTimeoutMs = normalizePrimeWaitTimeoutMs(waitTimeoutMs);

  if (!normalizedUserId) {
    return {
      queued: false,
      reason: "missing_user_id",
      retryAfterMs: 0,
      warmed: false,
      warming: false,
      waited: false,
      waitedMs: 0,
      waitTimeoutMs: normalizedWaitTimeoutMs,
      waitTimedOut: false,
      mealType,
    };
  }

  const retryAfterMs = getMlPrimeRetryAfterMs();
  if (retryAfterMs > 0) {
    return {
      queued: false,
      reason: "ml_service_unavailable",
      retryAfterMs,
      warmed: false,
      warming: false,
      waited: false,
      waitedMs: 0,
      waitTimeoutMs: normalizedWaitTimeoutMs,
      waitTimedOut: false,
      mealType,
    };
  }

  const requestStartedAt = Date.now();
  try {
    const primePayload = await buildMlPrimePayload({
      userId: resolvedUserId,
      demographics,
      mealType,
    });
    primePayload.wait_for_warmup = true;
    primePayload.wait_timeout_ms = normalizedWaitTimeoutMs;

    const responsePayload = await postMlPrimeRequest({
      payload: primePayload,
      timeoutMs: Math.max(ML_PRIME_REQUEST_TIMEOUT_MS, normalizedWaitTimeoutMs + 2000),
    });
    clearMlPrimeUnavailable();
    const result = normalizeMlPrimeResponse(responsePayload, {
      mealType,
      waitTimeoutMs: normalizedWaitTimeoutMs,
    });

    if (result.queued || result.warmed || result.warming || result.reason === "already_cached") {
      primedUsers.set(normalizedUserId, Date.now());
    }

    console.log("[dataAccess.js] ML prime wait request completed", {
      userId: normalizedUserId,
      elapsedMs: Date.now() - requestStartedAt,
      waitTimeoutMs: normalizedWaitTimeoutMs,
      warmed: result.warmed,
      warming: result.warming,
      waitTimedOut: result.waitTimedOut,
      reason: result.reason,
    });
    return result;
  } catch (error) {
    if (isMlPrimeAvailabilityError(error)) {
      const cooldownMs = markMlPrimeUnavailable();
      console.warn("[dataAccess.js] ML prime wait unavailable", {
        userId: normalizedUserId,
        code: error?.code || error?.name || null,
        status: Number(error?.status || 0) || null,
        retryAfterMs: cooldownMs,
      });
      return {
        queued: false,
        reason: "ml_service_unavailable",
        retryAfterMs: cooldownMs,
        warmed: false,
        warming: false,
        waited: false,
        waitedMs: 0,
        waitTimeoutMs: normalizedWaitTimeoutMs,
        waitTimedOut: false,
        mealType,
      };
    }

    console.error("[dataAccess.js] ML prime wait error:", error);
    return {
      queued: false,
      reason: "prime_wait_failed",
      retryAfterMs: 0,
      warmed: false,
      warming: false,
      waited: false,
      waitedMs: 0,
      waitTimeoutMs: normalizedWaitTimeoutMs,
      waitTimedOut: false,
      mealType,
    };
  }
};

export const getMlPrimeWarmupStatus = async ({ userId, demographics, mealType = "all" }) => {
  const rawUserId = userId;
  const normalizedUserId = String(userId || "").trim();
  const resolvedUserId = Number.isFinite(Number(normalizedUserId)) ? Number(normalizedUserId) : rawUserId;

  if (!normalizedUserId) {
    return {
      queued: false,
      reason: "missing_user_id",
      retryAfterMs: 0,
      warmed: false,
      warming: false,
      waited: false,
      waitedMs: 0,
      waitTimeoutMs: 0,
      waitTimedOut: false,
      mealType,
    };
  }

  if (primingUsers.has(normalizedUserId)) {
    return {
      queued: false,
      reason: "preparing_warmup",
      retryAfterMs: 0,
      warmed: false,
      warming: true,
      waited: false,
      waitedMs: 0,
      waitTimeoutMs: 0,
      waitTimedOut: false,
      mealType,
    };
  }

  const retryAfterMs = getMlPrimeRetryAfterMs();
  if (retryAfterMs > 0) {
    return {
      queued: false,
      reason: "ml_service_unavailable",
      retryAfterMs,
      warmed: false,
      warming: false,
      waited: false,
      waitedMs: 0,
      waitTimeoutMs: 0,
      waitTimedOut: false,
      mealType,
    };
  }

  try {
    const primePayload = await buildMlPrimePayload({
      userId: resolvedUserId,
      demographics,
      mealType,
    });
    const responsePayload = await postMlPrimeRequest({
      payload: primePayload,
      timeoutMs: ML_PRIME_REQUEST_TIMEOUT_MS,
      endpoint: `${ML_PRIME_URL}/status`,
    });
    clearMlPrimeUnavailable();
    const result = normalizeMlPrimeResponse(responsePayload, { mealType });

    if (result.warmed || result.warming) {
      primedUsers.set(normalizedUserId, Date.now());
    }

    return result;
  } catch (error) {
    if (isMlPrimeAvailabilityError(error)) {
      const cooldownMs = markMlPrimeUnavailable();
      console.warn("[dataAccess.js] ML prime status unavailable", {
        userId: normalizedUserId,
        code: error?.code || error?.name || null,
        status: Number(error?.status || 0) || null,
        retryAfterMs: cooldownMs,
      });
      return {
        queued: false,
        reason: "ml_service_unavailable",
        retryAfterMs: cooldownMs,
        warmed: false,
        warming: false,
        waited: false,
        waitedMs: 0,
        waitTimeoutMs: 0,
        waitTimedOut: false,
        mealType,
      };
    }

    console.error("[dataAccess.js] ML prime status error:", error);
    return {
      queued: false,
      reason: "prime_status_failed",
      retryAfterMs: 0,
      warmed: false,
      warming: false,
      waited: false,
      waitedMs: 0,
      waitTimeoutMs: 0,
      waitTimedOut: false,
      mealType,
    };
  }
};
