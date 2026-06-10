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

// Global ceiling applied to every /api route (health checks are mounted earlier
// and stay exempt).
export const globalLimiter = buildLimiter({
  windowMs: 60_000,
  max: toPositiveInt(process.env.RATE_LIMIT_GLOBAL_MAX, 300),
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
  max: toPositiveInt(process.env.RATE_LIMIT_FATSECRET_MAX, 60),
  message: "Too many nutrition lookup requests. Please wait a moment and try again.",
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
