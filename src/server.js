import express from 'express';
import 'dotenv/config';
import { ENV } from './config/env.js';
import job from './config/cron.js';
import demographicsRoutes from './routes/demographics.js';
import mealRoutes from './routes/meals.js';
import favoritesRoutes from './routes/favorites.js';
import shoppingRoutes from './routes/shopping.js';
import calorieRoutes from './routes/calorie.js';
import recommendationRoutes from './routes/recommendation.js';
import fatSecretRoutes from './routes/fatsecret.js';
import {
  ensureRecommendationFeedbackStorage,
  warmRecommendationRouteDependencies,
} from './routes/recommendation/dataAccess.js';
import profileRoutes from './routes/profile.js';
import deviceRoutes from './routes/devices.js';
import notificationRoutes from './routes/notifications.js';
import primeRoutes from './routes/prime.js';

import userRoutes from './routes/users.js';
import feedbackRoutes from './routes/feedback.js';

const app = express();
const PORT = ENV.PORT || 3000;
const MISSING_ROUTE_LOG_WINDOW_MS = 15 * 60 * 1000;
const recentMissingRouteLogs = new Map();

const buildHealthPayload = () => ({
  success: true,
  service: 'backend',
  uptimeSeconds: Math.round(process.uptime()),
});

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

// Increased limit to 50mb to handle Base64 images
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

if (ENV.NODE_ENV === "production") {job.start();}

app.use(express.json());

// Serve a stable root response so platform probes do not fail on `/`.
app.get('/', (req, res) => {
  res.status(200).json(buildHealthPayload());
});

// Mirror the health response on a generic path used by some hosting probes.
app.get('/health', (req, res) => {
  res.status(200).json(buildHealthPayload());
});

app.get("/api/health", (req, res) => {
  res.status(200).json(buildHealthPayload());
});

app.use('/api/users', userRoutes);
app.use('/api/demographics', demographicsRoutes)
app.use('/api/meals', mealRoutes);
app.use('/api/favorites', favoritesRoutes);
app.use('/api/shopping', shoppingRoutes);
app.use('/api/calorie', calorieRoutes);
app.use('/api/recommendation', recommendationRoutes);
app.use('/api/fatsecret', fatSecretRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/notifications', notificationRoutes);
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

void warmRecommendationRouteDependencies().catch((error) => {
  console.error('Recommendation route warmup failed:', error);
});

app.listen(PORT, () => {
  console.log('Server is running on port:', PORT);
});
