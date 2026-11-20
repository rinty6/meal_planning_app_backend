// Serve progress for one day, computed but dark (checklist m6-03, task T5,
// 2026-11-21).
//
// Whether serves are shown to users is still open (m0-06), so nothing in the
// app reads this yet. GET /api/meals/serve-progress/:clerkId answers only when
// SERVE_PROGRESS=on; otherwise it is a 404 and touches no database. The route
// in routes/meals.js stays thin: the gate and the sums live here so they can
// be tested without a database.
import { SERVE_GROUPS } from "./adgServeTargets.js";
import { indexPoolByPublicId, readTodayLogs, summariseToday } from "./todayIntake.js";

// T5, 2026-11-21: the flag is read per request, so turning it on or off needs
// no code change. Only the exact value "on" enables it.
export const isServeProgressEnabled = (env = process.env) =>
  String(env?.SERVE_PROGRESS ?? "").trim().toLowerCase() === "on";

/**
 * Express middleware placed FIRST in the route's chain: with the flag off it
 * answers 404 before the auth middleware looks the user up in the database.
 */
export const serveProgressGate = (env = process.env) => (req, res, next) => {
  if (!isServeProgressEnabled(env)) return res.status(404).json({ error: "Not enabled" });
  return next();
};

const pickServes = (source = {}) =>
  Object.fromEntries(SERVE_GROUPS.map((g) => [g, Math.round((Number(source?.[g]) || 0) * 100) / 100]));

/**
 * The response body for one user and day.
 *
 * @param {object} args
 * @param {object} args.db
 * @param {number} args.userId
 * @param {string} args.dateStr  YYYY-MM-DD, already checked by the route
 * @param {Function} args.getTargetContext  getDailyCalorieTargetContext
 * @param {Function} args.getPool           getPlannerPool
 * @param {Function} [args.readLogs]        readTodayLogs (injected in tests)
 */
export const buildServeProgress = async ({ db, userId, dateStr, getTargetContext, getPool, readLogs = readTodayLogs }) => {
  const [targetContext, logs, pool] = await Promise.all([
    getTargetContext({ db, userId, dateStr }),
    readLogs({ db, userId, dateStr }),
    getPool({ db }),
  ]);
  const today = summariseToday(logs, indexPoolByPublicId(pool));
  return {
    date: dateStr,
    targets: pickServes(targetContext?.serveTargets),
    eaten: pickServes(today.eatenServes),
    rowsWithoutServes: today.rowsWithoutServes,
    rows: logs.length,
  };
};
