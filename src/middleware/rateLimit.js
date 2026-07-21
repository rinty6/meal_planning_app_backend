// Phase 2A: basic abuse / DoS protection via express-rate-limit.
//
// Limits are per client IP (resolved from X-Forwarded-For because the app sets
// `trust proxy`). Defaults are deliberately generous: a normal mobile session
// fires several requests per screen and many users share carrier-grade NAT IPs,
// so these ceilings exist to stop floods and brute force, not to throttle real
// use. The global ceiling is tunable via env without a code change.
//
// NOTE on CGNAT: because buckets are keyed by IP, many users behind one carrier
// NAT share a bucket. Keep the global ceiling generous; if false 429s appear,
// raise RATE_LIMIT_GLOBAL_MAX or move authenticated routes to per-user keying.

import rateLimit from "express-rate-limit";

const toPositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const buildLimiter = ({ windowMs, max, message }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true, // RateLimit-* headers (incl. Retry-After on 429)
    legacyHeaders: false,
    message: {
      error: message || "Too many requests. Please slow down and try again shortly.",
    },
  });

// Route prefixes (relative to the /api mount) that carry their own dedicated
// limiter below. The global limiter skips these so one subsystem's traffic can
// never drain the budget unrelated routes depend on — before this skip existed,
// meal-planning image hydration (all /fatsecret traffic) was double-counted
// into the global bucket and starved calorie summary and notifications into
// 429s (ERROR_LOG Error 065). Flood protection for these prefixes is their own
// bucket, which is tighter than the global ceiling anyway.
const DEDICATED_BUCKET_PREFIXES = [
  "/users/bootstrap",
  "/recommendation",
  "/fatsecret",
  "/themealdb",
  "/food-recognition",
  "/meal-plan",
  "/prime",
  "/feedback",
];

// req.path inside the global limiter is relative to the /api mount point.
const hasDedicatedBucket = (req) => {
  const path = String(req.path || "");
  return DEDICATED_BUCKET_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  );
};

// Global ceiling applied to every /api route (health checks are mounted earlier
// and stay exempt). Routes with a dedicated bucket are skipped — see above.
export const globalLimiter = rateLimit({
  windowMs: 60_000,
  // Default raised 300 -> 600 (2026-07-20). Modern usage is fast screen-hopping,
  // and any environment WITHOUT explicit env values (e.g. local dev, which has no
  // RATE_LIMIT_* in backend/.env) was falling back to numbers tight enough to
  // throttle a single tester. Env values still override.
  max: toPositiveInt(process.env.RATE_LIMIT_GLOBAL_MAX, 600),
  standardHeaders: true,
  legacyHeaders: false,
  skip: hasDedicatedBucket,
  message: {
    error: "Too many requests. Please slow down and try again shortly.",
  },
});

// Email-sending: strict - abuse means spam and sender-reputation damage.
export const feedbackLimiter = buildLimiter({
  windowMs: 15 * 60_000,
  max: toPositiveInt(process.env.RATE_LIMIT_FEEDBACK_MAX, 5),
  message: "Too many feedback submissions. Please wait a few minutes and try again.",
});

// Compute-heavy recommendation routes.
export const recommendationLimiter = buildLimiter({
  windowMs: 60_000,
  max: toPositiveInt(process.env.RATE_LIMIT_RECOMMENDATION_MAX, 60),
});

// Third-party FatSecret proxy routes. Keep this tighter than the global ceiling
// because every miss can spend backend network and FatSecret quota.
export const fatSecretLimiter = buildLimiter({
  windowMs: 60_000,
  // Default raised 60 -> 240 (2026-07-20). Since cache hits no longer spend this
  // bucket, every token here represents a REAL upstream FatSecret call, so the
  // ceiling can be far more generous without risking quota: browsing many new
  // recipes fast is normal use, not abuse.
  max: toPositiveInt(process.env.RATE_LIMIT_FATSECRET_MAX, 240),
  message: "Too many nutrition lookup requests. Please wait a moment and try again.",
});

// TheMealDB proxy routes. Split from fatSecretLimiter (2026-07-20): both used to
// share one bucket, so browsing cuisines/recipes on TheMealDB could exhaust the
// budget FatSecret food/recipe search also needs, producing false 429s on
// unrelated screens (e.g. voice search) that never even touched TheMealDB.
export const theMealDbLimiter = buildLimiter({
  windowMs: 60_000,
  max: toPositiveInt(process.env.RATE_LIMIT_THEMEALDB_MAX, 120), // default raised 60 -> 120, same reasoning as fatSecretLimiter
  message: "Too many recipe lookup requests. Please wait a moment and try again.",
});

// Requests the backend can already answer from its own in-memory caches (see
// canServeFatSecretRequestFromCache / canServeTheMealDbRequestFromCache).
// These spend no third-party quota and ~0ms of compute, so they get a ceiling
// normal use cannot reach — this bucket exists only as flood protection, since
// the tight fatSecret/theMealDb buckets meter what actually costs money. This
// is why revisiting the same screens no longer burns the user's budget.
export const cachedContentLimiter = buildLimiter({
  windowMs: 60_000,
  max: toPositiveInt(process.env.RATE_LIMIT_CACHED_MAX, 1200),
  message: "Too many requests. Please slow down and try again shortly.",
});

// Dev-only rate-limit telemetry. express-rate-limit populates req.rateLimit with
// { limit, used, remaining } for whichever limiter ran last (the most specific
// one), so mounting this AFTER the limiters shows exactly which routes are
// consuming which bucket. Purpose: replace guesswork about "why did 3 recipe
// taps exhaust the budget" with a request-by-request ledger. Never runs in
// production — it would log every request.
let lastTelemetryAt = 0;

export const rateLimitTelemetry = (req, res, next) => {
  const info = req.rateLimit;
  if (info && Number.isFinite(info.remaining)) {
    const bucket = res.locals?.rateLimitBucket || "global";
    const now = Date.now();
    // Wall-clock time plus the gap since the previous API request. The gap is the
    // useful number: a steady stream of small gaps (tens of ms) with no user input
    // means something is looping, and gap x 60000 gives requests/minute directly.
    const stamp = new Date(now).toTimeString().slice(0, 8);
    const gap = lastTelemetryAt ? `+${String(now - lastTelemetryAt).padStart(5)}ms` : "    start";
    lastTelemetryAt = now;
    // Loud marker when a bucket is running low, so it stands out in the log wall.
    const flag = info.remaining <= Math.max(5, Math.floor(info.limit * 0.1)) ? "  <-- LOW" : "";
    console.log(
      `[ratelimit ${stamp} ${gap}] ${bucket.padEnd(9)} ${String(info.used).padStart(4)}/${info.limit} used, ` +
        `${String(info.remaining).padStart(4)} left  ${req.method} ${req.originalUrl.split("?")[0]}${flag}`
    );
  }
  return next();
};

// Image recognition proxy. These requests can be larger and trigger model
// inference, so keep a dedicated bucket below the global API ceiling.
export const foodRecognitionLimiter = buildLimiter({
  windowMs: 60_000,
  max: toPositiveInt(process.env.RATE_LIMIT_FOOD_RECOGNITION_MAX, 30),
  message: "Too many food recognition requests. Please wait a moment and try again.",
});

// ML warmup.
export const primeLimiter = buildLimiter({
  windowMs: 60_000,
  max: toPositiveInt(process.env.RATE_LIMIT_PRIME_MAX, 30),
});

// Startup account bootstrap.
export const bootstrapLimiter = buildLimiter({
  windowMs: 60_000,
  max: toPositiveInt(process.env.RATE_LIMIT_BOOTSTRAP_MAX, 20),
});
