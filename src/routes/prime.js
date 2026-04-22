import express from "express";

import {
  getMlPrimeWarmupStatus,
  getUserByClerkId,
  getUserDemographics,
  primeMlContext,
  primeMlContextAndWait,
} from "./recommendation/dataAccess.js";
import { parseBool } from "./recommendation/helpers.js";

const primeRoutes = express.Router();
const DEFAULT_PRIME_WAIT_TIMEOUT_MS = 25_000;
const MAX_PRIME_WAIT_TIMEOUT_MS = 60_000;

const toPrimeWaitTimeoutMs = (value, fallback = DEFAULT_PRIME_WAIT_TIMEOUT_MS) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(MAX_PRIME_WAIT_TIMEOUT_MS, Math.round(parsed)));
};

const buildPrimeRouteResponse = (resolvedUserId, primeResult = {}) => {
  const warmed = !!(primeResult.warmed || primeResult.reason === "already_cached");
  const warming = !!(
    primeResult.warming ||
    (!warmed && primeResult.queued) ||
    primeResult.reason === "already_priming"
  );

  return {
    primed:
      !!resolvedUserId &&
      (warmed || warming || primeResult.reason === "ttl_active"),
    queued: !!primeResult.queued,
    warmed,
    warming,
    waited: !!primeResult.waited,
    waitedMs: Number(primeResult.waitedMs || 0),
    waitTimeoutMs: Number(primeResult.waitTimeoutMs || 0),
    waitTimedOut: !!primeResult.waitTimedOut,
    reason: primeResult.reason || "unknown",
    retryAfterMs: Number(primeResult.retryAfterMs || 0),
  };
};

const resolvePrimeContext = async ({ clerkId, userId, demographics }) => {
  let resolvedUserId = userId || null;
  let resolvedDemographics = demographics || {};

  if (!resolvedUserId && clerkId) {
    const user = await getUserByClerkId(clerkId);
    resolvedUserId = user?.userId || null;
  }

  if (resolvedUserId && (!resolvedDemographics || Object.keys(resolvedDemographics).length === 0)) {
    resolvedDemographics = await getUserDemographics(resolvedUserId);
  }

  return {
    resolvedUserId,
    resolvedDemographics,
  };
};

primeRoutes.post("/", async (req, res) => {
  try {
    const { clerkId, userId, demographics, mealType } = req.body || {};
    const waitForWarmup = parseBool(req.body?.waitForWarmup) || parseBool(req.body?.wait_for_warmup);
    const waitTimeoutMs = toPrimeWaitTimeoutMs(
      req.body?.waitTimeoutMs ?? req.body?.wait_timeout_ms,
      DEFAULT_PRIME_WAIT_TIMEOUT_MS,
    );
    const { resolvedUserId, resolvedDemographics } = await resolvePrimeContext({
      clerkId,
      userId,
      demographics,
    });

    const primeResult = waitForWarmup
      ? await primeMlContextAndWait({
          userId: resolvedUserId,
          demographics: resolvedDemographics,
          mealType: mealType || "all",
          waitTimeoutMs,
        })
      : (primeMlContext({ userId: resolvedUserId, demographics: resolvedDemographics }) || {
          queued: false,
          reason: "missing_user_id",
        });

    return res.status(200).json(buildPrimeRouteResponse(resolvedUserId, primeResult));
  } catch (error) {
    console.error("Prime route error:", error);
    return res.status(500).json({ error: "Failed to prime ML context" });
  }
});

primeRoutes.get("/status/:clerkId", async (req, res) => {
  try {
    const { clerkId } = req.params;
    const mealType = String(req.query?.mealType || "all").trim().toLowerCase() || "all";
    const { resolvedUserId, resolvedDemographics } = await resolvePrimeContext({
      clerkId,
      userId: null,
      demographics: null,
    });

    const primeStatus = await getMlPrimeWarmupStatus({
      userId: resolvedUserId,
      demographics: resolvedDemographics,
      mealType,
    });

    return res.status(200).json(buildPrimeRouteResponse(resolvedUserId, primeStatus));
  } catch (error) {
    console.error("Prime status route error:", error);
    return res.status(500).json({ error: "Failed to fetch ML prime status" });
  }
});

export default primeRoutes;
