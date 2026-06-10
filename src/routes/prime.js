import express from "express";

import {
  getMlPrimeWarmupStatus,
  getUserByClerkId,
  getUserDemographics,
  primeMlContext,
  primeMlContextAndWait,
} from "./recommendation/dataAccess.js";
import { parseBool } from "./recommendation/helpers.js";
import { requireClerkAuth, ensureClerkIdMatch, attachUserFromAuth } from "../middleware/auth.js";

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

primeRoutes.post("/", requireClerkAuth, ensureClerkIdMatch("body"), attachUserFromAuth, async (req, res) => {
  try {
    const { mealType } = req.body || {};
    const waitForWarmup = parseBool(req.body?.waitForWarmup) || parseBool(req.body?.wait_for_warmup);
    const waitTimeoutMs = toPrimeWaitTimeoutMs(
      req.body?.waitTimeoutMs ?? req.body?.wait_timeout_ms,
      DEFAULT_PRIME_WAIT_TIMEOUT_MS,
    );
    // Derive identity from the verified token only; ignore any client-supplied
    // userId/demographics (mass-assignment guard).
    const resolvedUserId = req.dbUser.userId;
    const resolvedDemographics = await getUserDemographics(resolvedUserId);

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

primeRoutes.get("/status/:clerkId", requireClerkAuth, ensureClerkIdMatch("params"), attachUserFromAuth, async (req, res) => {
  try {
    const mealType = String(req.query?.mealType || "all").trim().toLowerCase() || "all";
    const resolvedUserId = req.dbUser.userId;
    const resolvedDemographics = await getUserDemographics(resolvedUserId);

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
