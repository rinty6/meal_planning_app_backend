import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { ENV } from './config/env.js';
import helmet from 'helmet';
import {
  globalLimiter,
  feedbackLimiter,
  recommendationLimiter,
  fatSecretLimiter,
  theMealDbLimiter,
  cachedContentLimiter,
  foodRecognitionLimiter,
  primeLimiter,
  bootstrapLimiter,
  rateLimitTelemetry,
} from './middleware/rateLimit.js';
import job from './config/cron.js';
import demographicsRoutes from './routes/demographics.js';
import mealRoutes from './routes/meals.js';
import favoritesRoutes from './routes/favorites.js';
import shoppingRoutes from './routes/shopping.js';
import calorieRoutes from './routes/calorie.js';
import recommendationRoutes from './routes/recommendation.js';
import fatSecretRoutes, { canServeFatSecretRequestFromCache } from './routes/fatsecret.js';
import mealPlanRoutes, { ensureMealPlanStorage } from './routes/mealPlan.js';
import {
  ensureRecommendationFeedbackStorage,
  warmRecommendationRouteDependencies,
} from './routes/recommendation/dataAccess.js';
import { warmFatSecretCache, warmFatSecretCacheInBackground } from './services/mealAPI.js';
import profileRoutes from './routes/profile.js';
import deviceRoutes from './routes/devices.js';
import notificationRoutes from './routes/notifications.js';
import internalRoutes from './routes/internal.js';
import primeRoutes from './routes/prime.js';
import foodRecognitionRoutes from './routes/foodRecognition.js';
import themealdbRoutes, { canServeTheMealDbRequestFromCache } from './routes/themealdb.js';

import userRoutes from './routes/users.js';
import feedbackRoutes from './routes/feedback.js';

const app = express();
const PORT = ENV.PORT || 3000;
const MISSING_ROUTE_LOG_WINDOW_MS = 15 * 60 * 1000;
const recentMissingRouteLogs = new Map();
const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);
// Keep the hosted privacy policy inside the backend repo so Railway deploys it with the service.
const privacyPolicyFilePath = path.resolve(currentDirPath, '../privacy_policy/index.html');

const bytesToMb = (value) => Math.round((Number(value || 0) / (1024 * 1024)) * 100) / 100;

const buildHealthPayload = () => ({
  success: true,
  service: 'backend',
  uptimeSeconds: Math.round(process.uptime()),
});

const buildRuntimeHealthPayload = () => {
  const cpuUsage = process.cpuUsage();
  const memoryUsage = process.memoryUsage();

  return {
    success: true,
    service: 'backend',
    generatedAt: new Date().toISOString(),
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    process: {
      cpuUserSeconds: Math.round((Number(cpuUsage.user || 0) / 1_000_000) * 1000) / 1000,
      cpuSystemSeconds: Math.round((Number(cpuUsage.system || 0) / 1_000_000) * 1000) / 1000,
      rssMb: bytesToMb(memoryUsage.rss),
      heapTotalMb: bytesToMb(memoryUsage.heapTotal),
      heapUsedMb: bytesToMb(memoryUsage.heapUsed),
      externalMb: bytesToMb(memoryUsage.external),
      arrayBuffersMb: bytesToMb(memoryUsage.arrayBuffers),
    },
  };
};

const requireInternalSecret = (req, res, next) => {
  const secret = ENV.INTERNAL_TRIGGER_SECRET;
  if (!secret) {
    return res
      .status(503)
      .json({ error: "Runtime telemetry disabled: INTERNAL_TRIGGER_SECRET is not configured" });
  }

  const provided = req.headers["x-internal-secret"];
  if (!provided || String(provided) !== String(secret)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  return next();
};

const shouldLogMissingRoute = (method, path) => {
  const cacheKey = `${method}:${path}`;
  const now = Date.now();
  const lastLoggedAt = recentMissingRouteLogs.get(cacheKey) || 0;
  if (now - lastLoggedAt < MISSING_ROUTE_LOG_WINDOW_MS) {
    return false;
  }

  recentMissingRouteLogs.set(cacheKey, now);
  return true;
};

const isTruthyEnv = (value) => ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
const isFalseyEnv = (value) => ["0", "false", "no", "off"].includes(String(value || "").trim().toLowerCase());
const shouldStartScheduledJobs = () => {
  if (isTruthyEnv(process.env.NOTIFICATIONS_CRON_DISABLED) || isFalseyEnv(process.env.NOTIFICATIONS_CRON_ENABLED)) {
    return false;
  }

  const explicitlyEnabled = isTruthyEnv(process.env.NOTIFICATIONS_CRON_ENABLED);
  const isRailwayRuntime = Boolean(
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_PROJECT_ID ||
    process.env.RAILWAY_SERVICE_ID
  );

  return explicitlyEnabled || ENV.NODE_ENV === "production" || isRailwayRuntime;
};

// Trust the Railway/edge proxy so rate limiting and req.ip use the real client
// IP (X-Forwarded-For), not the proxy address. `1` trusts only the first hop.
app.set('trust proxy', 1);

// Security headers. CSP is disabled: this service is a JSON API plus one static
// privacy-policy page, so a strict CSP would risk breaking that page without
// adding meaningful protection to API responses.
app.use(helmet({ contentSecurityPolicy: false }));

if (shouldStartScheduledJobs()) {
  job.start();
  console.log("Notification cron jobs enabled for this backend process", {
    nodeEnv: ENV.NODE_ENV,
    railwayRuntime: Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID),
    notificationsCronEnabled: process.env.NOTIFICATIONS_CRON_ENABLED || null,
    notificationsCronDisabled: process.env.NOTIFICATIONS_CRON_DISABLED || null,
  });
} else {
  console.log("Notification cron jobs not started", {
    nodeEnv: ENV.NODE_ENV,
    railwayRuntime: Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID),
    notificationsCronEnabled: process.env.NOTIFICATIONS_CRON_ENABLED || null,
    notificationsCronDisabled: process.env.NOTIFICATIONS_CRON_DISABLED || null,
  });
}

// Serve a stable root response so platform probes do not fail on `/`.
app.get('/', (req, res) => {
  res.status(200).json(buildHealthPayload());
});

// Answer browser favicon probes quietly so they do not pollute missing-route logs.
app.get('/favicon.ico', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400, immutable');
  res.status(204).end();
});

// Expose the privacy policy as a public page for App Store Connect.
app.get(['/privacy-policy', '/privacy-policy/', '/privacy-policy.html'], (req, res) => {
  res.sendFile(privacyPolicyFilePath);
});

// Serve curated transparent ingredient images as static assets. These PNGs are
// committed to the repo (backend/public/ingredients) so Railway deploys them with
// the service. Filenames are stable, so cache aggressively. CORP is set to
// cross-origin so the mobile app can load them. Used by the recipe detail page
// via ingredientImages.json `baseUrl`.
const ingredientImagesDir = path.resolve(currentDirPath, '../public/ingredients');
app.use('/ingredients', express.static(ingredientImagesDir, {
  maxAge: '365d',
  immutable: true,
  setHeaders: (res) => {
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  },
}));

// Mirror the health response on a generic path used by some hosting probes.
app.get('/health', (req, res) => {
  warmFatSecretCacheInBackground('health');
  res.status(200).json(buildHealthPayload());
});

app.get("/api/health", (req, res) => {
  warmFatSecretCacheInBackground('api_health');
  res.status(200).json(buildHealthPayload());
});

// This is a JSON API with no crawlable pages. Answer /robots.txt with a blanket
// disallow so web crawlers (OAI-SearchBot, etc.) get a clean 200 instead of
// falling through to the unmatched-route warner and spamming the logs.
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').status(200).send('User-agent: *\nDisallow: /\n');
});

// Mirror backend process telemetry on a guarded route for ops checks.
// Keep /health and /api/health public; this endpoint exposes process details.
app.get('/api/health/runtime', requireInternalSecret, (req, res) => {
  res.status(200).json(buildRuntimeHealthPayload());
});

// Global rate-limit ceiling for all API routes. Health checks above are defined
// earlier, so they remain exempt. Routes with a dedicated bucket below are
// skipped inside the limiter (DEDICATED_BUCKET_PREFIXES in middleware/rateLimit.js)
// so e.g. image-hydration bursts on /api/fatsecret cannot drain the budget that
// calorie summary or notifications depend on.
app.use('/api', globalLimiter);

// Tighter per-route limiters on abuse-prone / expensive surfaces.
// FatSecret/TheMealDB requests the backend cache can already answer cost no
// third-party quota, so they are metered by the generous cachedContentLimiter
// instead of the tight per-provider buckets — repeat screen visits stay free
// even while the tight bucket is exhausted.
const tagBucket = (name, limiter) => (req, res, next) => {
  res.locals.rateLimitBucket = name; // read by rateLimitTelemetry below
  return limiter(req, res, next);
};

app.use('/api/users/bootstrap', tagBucket('bootstrap', bootstrapLimiter));
app.use('/api/recommendation', tagBucket('recommend', recommendationLimiter));
app.use('/api/fatsecret', (req, res, next) =>
  canServeFatSecretRequestFromCache(req)
    ? tagBucket('cached', cachedContentLimiter)(req, res, next)
    : tagBucket('fatsecret', fatSecretLimiter)(req, res, next));
app.use('/api/themealdb', (req, res, next) =>
  canServeTheMealDbRequestFromCache(req)
    ? tagBucket('cached', cachedContentLimiter)(req, res, next)
    : tagBucket('themealdb', theMealDbLimiter)(req, res, next));
app.use('/api/food-recognition', tagBucket('foodrecog', foodRecognitionLimiter));
app.use('/api/meal-plan', tagBucket('recommend', recommendationLimiter));
app.use('/api/prime', tagBucket('prime', primeLimiter));
app.use('/api/feedback', tagBucket('feedback', feedbackLimiter));

// Local-dev-only: log which bucket each request charged and how much headroom is
// left, so a slow screen or an unexpected 429 can be traced to the exact routes
// that spent the budget instead of guessed at.
//
// The Railway check is NOT redundant with the NODE_ENV check: ENV.NODE_ENV falls
// back to 'development' when the variable is unset, so keying off it alone would
// log a line for EVERY request in production if Railway did not set NODE_ENV.
// Same reasoning as shouldStartScheduledJobs() above. Set RATE_LIMIT_TELEMETRY=true
// to force it on temporarily when debugging a deployed environment.
const isRailwayRuntime = Boolean(
  process.env.RAILWAY_ENVIRONMENT ||
  process.env.RAILWAY_PROJECT_ID ||
  process.env.RAILWAY_SERVICE_ID
);
const telemetryEnabled = isTruthyEnv(process.env.RATE_LIMIT_TELEMETRY)
  || (ENV.NODE_ENV !== 'production' && !isRailwayRuntime);
if (telemetryEnabled) {
  app.use('/api', rateLimitTelemetry);
}

// Body limits: a tight 1 MB default protects the ~40 JSON routes; routes that
// legitimately accept base64 images (feedback photo, manual-food photo, recipe
// photo upload) get a 10 MB cap. Previously every route accepted 50 MB.
// Limiters are mounted first so rejected floods do not need body parsing.
app.use('/api/feedback', express.json({ limit: '10mb' }));
app.use('/api/meals', express.json({ limit: '10mb' }));
app.use('/api/food-recognition', express.json({ limit: '10mb' }));
app.use('/api/favorites', express.json({ limit: '10mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: true }));

app.use('/api/users', userRoutes);
app.use('/api/demographics', demographicsRoutes)
app.use('/api/meals', mealRoutes);
app.use('/api/favorites', favoritesRoutes);
app.use('/api/shopping', shoppingRoutes);
app.use('/api/calorie', calorieRoutes);
app.use('/api/recommendation', recommendationRoutes);
app.use('/api/fatsecret', fatSecretRoutes);
app.use('/api/themealdb', themealdbRoutes);
app.use('/api/food-recognition', foodRecognitionRoutes);
app.use('/api/meal-plan', mealPlanRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/internal', internalRoutes);
app.use('/api/prime', primeRoutes);
app.use('/api/feedback', feedbackRoutes);

app.use((req, res) => {
  const requestPath = req.originalUrl || req.url || '/';
  if ((req.method === 'GET' || req.method === 'HEAD') && shouldLogMissingRoute(req.method, requestPath)) {
    // Log sampled missing-route details so repeated platform probes are identifiable.
    console.warn('[server.js] Unmatched GET/HEAD request', {
      method: req.method,
      path: requestPath,
      host: req.get('host') || null,
      userAgent: req.get('user-agent') || null,
      ip: req.ip || null,
    });
  }

  res.status(404).json({ error: 'Not found' });
});

void ensureRecommendationFeedbackStorage().catch((error) => {
  console.error('Recommendation feedback storage bootstrap failed:', error);
});

void ensureMealPlanStorage().catch((error) => {
  console.error('Meal-plan storage bootstrap failed:', error);
});

void warmRecommendationRouteDependencies().catch((error) => {
  console.error('Recommendation route warmup failed:', error);
});

// Eagerly fetch the FatSecret OAuth token and prime the in-process apiCache for
// the default Recipe and Meal-Planning searches so the first real visit after a
// deploy does not pay the cold-start latency captured in the logs.
void warmFatSecretCache().catch((error) => {
  console.error('FatSecret cache warmup failed:', error);
});

app.listen(PORT, () => {
  console.log('Server is running on port:', PORT);
});
