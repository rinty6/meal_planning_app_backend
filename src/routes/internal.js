// Ops-only manual trigger for the scheduled notification jobs.
//
// Lets us fire a meal skip-check / daily-summary on demand instead of waiting for
// the 10:00 / 14:00 / 20:00 / 21:00 local cron times. This verifies the full
// cron-logic -> recipient-selection -> Expo-delivery chain (and whether the
// in-process cron firing on Railway is the remaining unknown).
//
// NOTE: the breakfast/lunch/dinner jobs FORCE-send. They deliberately bypass the
// "was this meal already logged?" gate and the 2/day anti-nag cap so a tester can
// see the copy without starving themselves. Use job "dispatch" to exercise the
// real conditional path.
//
// This is NOT a user route — it sends real pushes — so it is guarded by a
// shared secret header instead of Clerk auth.
//
//   POST /api/internal/run-reminders
//   headers: { "x-internal-secret": "<INTERNAL_TRIGGER_SECRET>" }
//   body:    { "job": "breakfast" | "lunch" | "dinner" | "summary" | "dispatch",
//              "clerkId"?: "user_...",
//              "hour"?: 0-23,      // dispatch only: pretend it is this LOCAL hour
//              "reset"?: true }    // dispatch only: clear today's dispatch log first
//
// "dispatch" + "hour" is the only way to exercise the real conditional path (the
// unlogged-meal gate and the 2/day anti-nag cap). "reset" clears the dedup ledger
// for the targeted user so the same day can be replayed.
//
// `clerkId` (optional) restricts the run to a single user while still applying
// the real eligibility gate, so recipientCount=0 means "selection excluded
// them" and recipientCount=1 + sent=1 means "the whole pipeline works".

import express from "express";
import { eq } from "drizzle-orm";
import { db } from "../config/db.js";
import { usersTable } from "../db/schema.js";
import { ENV } from "../config/env.js";
import {
  runBreakfastReminder,
  runLunchReminder,
  runDinnerReminder,
  runDailySummary,
  runReminderDispatch,
} from "../config/cron.js";

const internalRoutes = express.Router();

const JOB_RUNNERS = {
  breakfast: runBreakfastReminder,
  lunch: runLunchReminder,
  dinner: runDinnerReminder,
  summary: runDailySummary,
  // "dispatch" runs a full dispatcher tick (respects each user's local time + dedup);
  // the individual meal jobs force-send immediately, ignoring time, for testing.
  dispatch: runReminderDispatch,
};

const requireInternalSecret = (req, res, next) => {
  const secret = ENV.INTERNAL_TRIGGER_SECRET;
  if (!secret) {
    return res
      .status(503)
      .json({ error: "Manual trigger disabled: INTERNAL_TRIGGER_SECRET is not configured" });
  }
  const provided = req.headers["x-internal-secret"];
  if (!provided || String(provided) !== String(secret)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  return next();
};

internalRoutes.post("/run-reminders", requireInternalSecret, async (req, res) => {
  try {
    const { job, clerkId } = req.body || {};
    const jobKey = String(job || "").toLowerCase();
    const runner = JOB_RUNNERS[jobKey];
    if (!runner) {
      return res
        .status(400)
        .json({ error: `Invalid job. Use one of: ${Object.keys(JOB_RUNNERS).join(", ")}` });
    }

    let restrictToUserId = null;
    if (clerkId) {
      const rows = await db
        .select({ userId: usersTable.userId })
        .from(usersTable)
        .where(eq(usersTable.clerkId, String(clerkId)))
        .limit(1);
      if (!rows.length) {
        return res.status(404).json({ error: `No user found for clerkId ${clerkId}` });
      }
      restrictToUserId = rows[0].userId;
    }

    // Only the "dispatch" job reads these; the force runners ignore them.
    const { hour, reset } = req.body || {};
    const forceHour = hour == null || hour === "" ? null : Number(hour);
    if (forceHour != null && (!Number.isInteger(forceHour) || forceHour < 0 || forceHour > 23)) {
      return res.status(400).json({ error: "hour must be an integer 0-23" });
    }

    const startedAt = Date.now();
    const result = await runner({ restrictToUserId, forceHour, resetToday: Boolean(reset) });

    return res.status(200).json({
      success: true,
      job: jobKey,
      clerkId: clerkId || null,
      restrictToUserId,
      durationMs: Date.now() - startedAt,
      result,
    });
  } catch (error) {
    console.error("[internal] run-reminders error:", error);
    return res.status(500).json({ error: "Failed to run job" });
  }
});

export default internalRoutes;
