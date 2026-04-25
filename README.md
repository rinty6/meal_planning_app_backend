# ⚙️ GoodHealthMate Backend (Node.js)

This folder contains the Node.js / Express backend for the meal planning app. It is the integration layer between the mobile client, PostgreSQL, push notifications, feedback handling, and the Python recommendation service.

## Responsibilities

The backend is responsible for:

- serving the main REST API used by the mobile app
- reading and writing user data in PostgreSQL
- resolving Clerk-backed user identity on protected flows
- calling the machine learning service for recommendation generation and cache priming
- handling notification device registration and push delivery helpers
- sending feedback email and storing recommendation feedback
- exposing health endpoints for local and hosted deployments

## Route Surface

The API is split by feature area under `src/routes/`.

Main route groups:

- health: `GET /`, `GET /health`, `GET /api/health`
- users: `POST/GET` flows under `/api/users`
- demographics: `/api/demographics`
- meals: `/api/meals`
- favorites: `/api/favorites`
- shopping: `/api/shopping`
- calories: `/api/calorie`
- profile: `/api/profile`
- devices: `/api/devices`
- notifications: `/api/notifications`
- feedback: `/api/feedback`
- FatSecret integration: `/api/fatsecret`
- recommendations: `GET /api/recommendation/:clerkId`, `POST /api/recommendation/feedback`
- recommendation warmup: `POST /api/prime`, `GET /api/prime/status/:clerkId`

Two recommendation-related behaviors are important operationally:

- the backend normalizes live recommendation responses before returning them to the app
- the prime route can either queue warmup quickly or wait for warmup completion when `waitForWarmup` is requested

## Tech Stack

- Node.js with native ESM modules
- Express 5
- Neon PostgreSQL
- Drizzle ORM and Drizzle Kit
- Clerk backend SDK
- Nodemailer
- Expo push support through `expo-server-sdk`
- Cron-based jobs for production reminders and summaries

## Environment Variables

This service does not currently ship with a checked-in `.env.example`, so the runtime contract is documented here.

Core variables:

- `PORT`: backend port, defaults to `5000`
- `DB_URL`: PostgreSQL connection string used by Neon / Drizzle
- `NODE_ENV`: set to `production` in hosted environments
- `CLERK_SECRET_KEY`: required for Clerk-backed server operations

Recommendation service variables:

- `ML_SERVICE_URL`: defaults to `http://localhost/api/recommendation`
- `ML_SERVICE_PRIME_URL`: defaults to `http://localhost/api/prime`
- `RECOMMENDATION_DEBUG_LOGS`: set to `1` to log detailed recommendation timing and response summaries

Feature-specific variables:

- `FATSECRET_CLIENT_ID`: required for FatSecret-backed lookups
- `FATSECRET_CLIENT_SECRET`: required for FatSecret-backed lookups
- `EMAIL_USER`: sender account for feedback mail flows
- `EMAIL_PASSWORD`: sender password or app password for feedback mail flows

## Local Development

### Install

```bash
npm install
```

### Run In Development

```bash
npm run dev
```

### Run In Production Mode Locally

```bash
npm start
```

### Database Push

```bash
npm run db:push
```

### Inspect A User Record

```bash
npm run users:inspect
```

## Recommendation Flow

The recommendation path is intentionally split:

1. the backend loads the user, demographics, active calorie goal, favorites, and feedback profile
2. it calls the ML service with that context
3. it reshapes the ML payload into a stable API response for the mobile app
4. it stores explicit user feedback separately through the feedback endpoint

The backend also performs warmup-related work on startup:

- recommendation feedback storage bootstrap
- recommendation dependency warmup

## Health And Hosting Notes

The backend now returns a stable JSON payload on all of these paths:

- `/`
- `/health`
- `/api/health`

That is important for hosts such as Railway, where platform probes often hit `/` or `/health` even if the application originally only exposed `/api/health`.

Unmatched `GET` and `HEAD` requests are sampled into warning logs so future probe mismatches can be identified without spamming logs.

## Cron Behavior

Cron jobs are started only when `NODE_ENV === "production"`.

That means:

- local development will not automatically start reminder and summary jobs unless you explicitly run in production mode
- hosted deployments should be treated as single-process schedulers unless you intentionally split cron into a dedicated worker topology

## Railway Deployment Notes

Recommended deployment checklist:

1. set `NODE_ENV=production`
2. configure `DB_URL`, `CLERK_SECRET_KEY`, and any required email or FatSecret credentials
3. point `ML_SERVICE_URL` and `ML_SERVICE_PRIME_URL` at the deployed ML service
4. verify `GET /health` and `GET /` return `200`
5. verify `POST /api/prime` and `GET /api/prime/status/:clerkId` behave correctly against the live ML service
6. confirm cron behavior is acceptable for the number of running backend instances

## Workspace Relationship

This backend is designed to sit between the sibling projects:

- `../meal_app` consumes this API directly
- `../machine_learning` provides recommendation generation and prime status responses

If you deploy services independently, keep the backend-to-ML URLs in sync with the ML host.
