import cron from "cron";
import dotenv from "dotenv";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "./db.js";
import {
    calorieGoalsTable,
    mealLogsTable,
    notificationDispatchLogTable,
    userDevicesTable,
    usersTable,
} from "../db/schema.js";
import { resolveCalorieZone } from "../services/calorieTargetBand.js";
import { getPipImageUrl } from "../services/pipNotificationImage.js";
import {
    cleanupOldNotifications,
    sendNotificationToUser,
} from "../services/notificationService.js";

dotenv.config();

// The cron itself is timezone-agnostic — it ticks every 15 minutes and computes
// each user's LOCAL time from users.timezone. This zone is only the fallback for
// users whose device never reported one.
const NOTIFICATION_TIME_ZONE = process.env.NOTIFICATION_TIME_ZONE || "Australia/Adelaide";
const DEFAULT_TIME_ZONE = NOTIFICATION_TIME_ZONE;

// Every 15 minutes. Australia's fractional zones (:00, :30, :45) are all
// multiples of 15, so each user's local "top of hour" lands on exactly one tick.
const DISPATCH_CRON = "*/15 * * * *";
const DISPATCH_WINDOW_MINUTES = 15;
const DISPATCH_LOG_RETENTION_DAYS = 3;

// SKIP-CHECKS, not pre-meal alarms (Pip Phase 4, 2026-08-05).
//
// The old scheme nudged at 8/12/18 whether or not the meal had been logged,
// which meant the most diligent users got reminded to do the thing they had
// already done. These fire AFTER each meal window closes and ONLY when nothing
// was logged against that meal, so a user who logs on time hears nothing.
//
// Hours match the windows in meal_app/components/pip/pipHomeState.ts
// (breakfast 7-10, lunch 11-14, dinner 17-20) — each check sits on the closing
// edge of its window. They remain INDEPENDENT of any calorie goal (Phase 3
// decoupling): a device + the master switch is the whole eligibility test.
const MEAL_SKIP_CHECKS_BY_HOUR = {
    10: {
        type: "breakfast",
        title: "A fresh start, mate!",
        body: "Quick brekkie now can help set up the rest of your day.",
    },
    14: {
        type: "lunch",
        title: "Still plenty of day left!",
        body: "Little feed now can help carry you through the arvo.",
    },
    20: {
        type: "dinner",
        title: "You’ve got this, mate!",
        body: "Simple dinner can help you wind down and finish the day well.",
    },
};
const MEAL_SKIP_CHECKS_BY_TYPE = Object.fromEntries(
    Object.entries(MEAL_SKIP_CHECKS_BY_HOUR).map(([hour, def]) => [def.type, { hour: Number(hour), ...def }])
);
const MEAL_SKIP_TYPES = Object.keys(MEAL_SKIP_CHECKS_BY_TYPE);

// The calorie summary still requires a notification-enabled calorie goal. It sits
// an hour after the dinner skip-check so the two never read as one burst.
const SUMMARY_HOUR = 21;

// Anti-nag cap: 2 pushes per user per local day, total. The summary reserves one
// slot, which leaves exactly one meal skip-check — the first that comes due.
// Someone skipping all three meals hears about it once, not three times.
const MAX_MEAL_NUDGES_PER_DAY = 1;

// Which Pip the summary wears, per band. "over" gets Confident rather than
// anything disapproving — the locked rule is that Pip never scolds.
const SUMMARY_PIP_STATE = {
    on_target: "happy",
    over: "confident",
    under: "care",
};

// End-of-day copy, keyed by the tolerance band in services/calorieTargetBand.js.
// Pip never scolds: "over" is reassurance, not a telling-off.
const SUMMARY_COPY = {
    on_target: {
        title: "Nailed it, mate!",
        body: (consumed, target) =>
            `${consumed} kcal against your ${target} kcal target. That’s the day done right.`,
    },
    under: {
        title: "No dramas, mate!",
        body: () => "You didn’t quite hit today’s target—tomorrow’s a fresh go.",
    },
    over: {
        title: "Big day, and that’s alright!",
        body: () => "One day over doesn’t undo a good week. Back at it tomorrow.",
    },
};

const toNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

// Resolve a user's local date + hour + minute from their IANA timezone.
const getLocalParts = (timeZone) => {
    const format = (zone) =>
        new Intl.DateTimeFormat("en-CA", {
            timeZone: zone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        }).formatToParts(new Date());

    let parts;
    try {
        parts = format(timeZone || DEFAULT_TIME_ZONE);
    } catch {
        parts = format(DEFAULT_TIME_ZONE);
    }

    const map = {};
    for (const part of parts) map[part.type] = part.value;
    let hour = parseInt(map.hour, 10);
    if (hour === 24) hour = 0; // some ICU builds emit "24" for midnight
    return {
        localDate: `${map.year}-${map.month}-${map.day}`,
        hour,
        minute: parseInt(map.minute, 10),
    };
};

const getLatestActiveNotificationGoalForUser = async (userId, dateStr) => {
    const goals = await db
        .select()
        .from(calorieGoalsTable)
        .where(
            and(
                eq(calorieGoalsTable.userId, userId),
                eq(calorieGoalsTable.notificationsEnabled, true),
                lte(calorieGoalsTable.startDate, dateStr),
                gte(calorieGoalsTable.endDate, dateStr)
            )
        )
        .orderBy(desc(calorieGoalsTable.createdAt))
        .limit(1);

    return goals[0] || null;
};

// Users eligible for MEAL reminders: have a device AND master switch on.
// (No calorie-goal requirement — that is the Phase 3 decoupling.)
const getMealReminderEligibleUserIds = async () => {
    const deviceRows = await db.select({ userId: userDevicesTable.userId }).from(userDevicesTable);
    const usersWithDevices = new Set(deviceRows.map((row) => row.userId).filter(Boolean));
    if (usersWithDevices.size === 0) return [];

    const masterRows = await db
        .select({ userId: usersTable.userId, master: usersTable.notificationsMasterEnabled })
        .from(usersTable);
    const masterDisabled = new Set(
        masterRows.filter((row) => row.master === false).map((row) => row.userId)
    );

    return [...usersWithDevices].filter((userId) => !masterDisabled.has(userId));
};

// Claim a (user, type, localDate) slot. Returns true only for the first caller,
// so a reminder is sent at most once per user per local day.
const claimDispatch = async (userId, reminderType, localDate) => {
    const inserted = await db
        .insert(notificationDispatchLogTable)
        .values({ userId, reminderType, localDate })
        .onConflictDoNothing()
        .returning({ id: notificationDispatchLogTable.id });
    return inserted.length > 0;
};

const cleanupOldDispatchLogs = async () => {
    const cutoff = new Date(Date.now() - DISPATCH_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    await db.delete(notificationDispatchLogTable).where(lte(notificationDispatchLogTable.createdAt, cutoff));
};

// How many meal nudges this user has already had today. The dispatch log is
// already the dedup ledger, so it doubles as the anti-nag counter for free —
// no extra table, and it is pruned by the same retention job.
const countMealNudgesToday = async (userId, localDate) => {
    const rows = await db
        .select({ id: notificationDispatchLogTable.id })
        .from(notificationDispatchLogTable)
        .where(
            and(
                eq(notificationDispatchLogTable.userId, userId),
                eq(notificationDispatchLogTable.localDate, localDate),
                inArray(notificationDispatchLogTable.reminderType, MEAL_SKIP_TYPES)
            )
        );
    return rows.length;
};

const getLoggedMealTypesForDay = async (userId, localDate) => {
    const rows = await db
        .select({ mealType: mealLogsTable.mealType })
        .from(mealLogsTable)
        .where(and(eq(mealLogsTable.userId, userId), eq(mealLogsTable.date, localDate)));
    return new Set(rows.map((row) => String(row.mealType || "").trim().toLowerCase()));
};

// A skipped meal is Pip's sad state — the same one the home card shows for a
// fresh miss, so the notification and the app agree on the bird.
const SKIP_CHECK_PIP_STATE = "sad";

const sendMealSkipCheckToUser = async ({ userId, reminderType, title, body }) => {
    const imageUrl = getPipImageUrl(SKIP_CHECK_PIP_STATE);
    const result = await sendNotificationToUser({
        userId,
        title,
        body,
        data: {
            type: `${reminderType}_reminder`,
            mealType: reminderType,
            pip: SKIP_CHECK_PIP_STATE,
            // Duplicated from the richContent field on purpose — see the note on
            // pipImage in sendDailySummaryToUser().
            pipImage: imageUrl,
            screen: "/(tabs)/meal/summary",
        },
        imageUrl,
    });
    return result?.sent ?? 0;
};

// Build + send the calorie summary for one user on their local date.
// Returns { eligible } so callers can distinguish "no goal" from "sent".
const sendDailySummaryToUser = async ({ userId, localDate }) => {
    // Only summarise against a goal whose date range covers today. A completed or
    // expired goal (or none at all) yields no summary — we deliberately do NOT fall
    // back to the latest goal, otherwise the nightly praise keeps firing after a
    // goal has ended even though the user never set a new one.
    const goal = await getLatestActiveNotificationGoalForUser(userId, localDate);
    if (!goal) return { eligible: false, sent: 0 };

    const target = toNumber(goal.dailyCalories) || 2000;
    const meals = await db
        .select()
        .from(mealLogsTable)
        .where(and(eq(mealLogsTable.userId, userId), eq(mealLogsTable.date, localDate)));

    const consumed = meals.reduce((sum, meal) => sum + toNumber(meal.calories), 0);

    // The old copy was a two-way split on `consumed > target`, which praised
    // ("You stayed under your goal") a user who ate 900 of 2200 kcal — the exact
    // person the missed-target message is for. The ±10% band gives three honest
    // outcomes instead. See services/calorieTargetBand.js.
    const zone = resolveCalorieZone(consumed, target);
    const copy = SUMMARY_COPY[zone];
    const title = copy.title;
    const body = copy.body(Math.round(consumed).toLocaleString("en-US"), Math.round(target).toLocaleString("en-US"));
    const pip = SUMMARY_PIP_STATE[zone];
    const imageUrl = getPipImageUrl(pip);

    const result = await sendNotificationToUser({
        userId,
        title,
        body,
        data: {
            type: "daily_summary",
            date: localDate,
            zone,
            pip,
            // The same URL rides in BOTH richContent (via imageUrl below) and here
            // in data. richContent is how Expo's own Android renderer finds the
            // image, but how Expo maps that field into the iOS APNs payload is
            // undocumented — so the iOS Notification Service Extension would be
            // guessing where to look. `data` is ours and always arrives intact in
            // userInfo, so the extension reads pipImage from there instead of
            // depending on Expo's internal shape.
            pipImage: imageUrl,
            screen: "/(tabs)/profile/notifications",
        },
        imageUrl,
    });
    return { eligible: true, sent: result?.sent ?? 0 };
};

// ---------------------------------------------------------------------------
// The dispatcher — runs every 15 min, sends each due reminder at LOCAL time.
// ---------------------------------------------------------------------------
// `forceHour` / `resetToday` exist ONLY for the manual trigger in routes/internal.js.
// The scheduled job never passes them. Without them the new conditional logic is
// untestable on demand: the force runners bypass the gates entirely, and a real
// tick only does anything at 10:00/14:00/20:00/21:00 local — and then only once
// per day, so you would get one shot at observing the cap.
export const runReminderDispatch = async ({
    restrictToUserId = null,
    forceHour = null,
    resetToday = false,
} = {}) => {
    await cleanupOldNotifications();
    await cleanupOldDispatchLogs();

    const eligibleIds = new Set(await getMealReminderEligibleUserIds());
    let users = await db
        .select({ userId: usersTable.userId, timezone: usersTable.timezone })
        .from(usersTable);
    users = users.filter((user) => eligibleIds.has(user.userId));
    if (restrictToUserId != null) users = users.filter((user) => user.userId === restrictToUserId);

    const dispatched = { breakfast: 0, lunch: 0, dinner: 0, summary: 0, skippedAlreadyLogged: 0, skippedNagCap: 0 };

    for (const user of users) {
        const parts = getLocalParts(user.timezone);
        const { localDate, minute } = parts;
        const hour = forceHour == null ? parts.hour : Number(forceHour);
        // The minute gate keeps the 15-min cron to one bucket per local hour. A
        // forced run has no bucket to collide with, so it does not apply.
        if (forceHour == null && minute >= DISPATCH_WINDOW_MINUTES) continue;

        if (resetToday) {
            await db
                .delete(notificationDispatchLogTable)
                .where(
                    and(
                        eq(notificationDispatchLogTable.userId, user.userId),
                        eq(notificationDispatchLogTable.localDate, localDate)
                    )
                );
        }

        const meal = MEAL_SKIP_CHECKS_BY_HOUR[hour];
        if (meal) {
            // Nothing to nudge about if they already ate and logged it. Checked
            // before the claim so a logged meal does not burn the dedup slot.
            const logged = await getLoggedMealTypesForDay(user.userId, localDate);
            if (logged.has(meal.type)) {
                dispatched.skippedAlreadyLogged += 1;
                continue;
            }

            if ((await countMealNudgesToday(user.userId, localDate)) >= MAX_MEAL_NUDGES_PER_DAY) {
                dispatched.skippedNagCap += 1;
                continue;
            }

            const claimed = await claimDispatch(user.userId, meal.type, localDate);
            if (!claimed) continue;
            await sendMealSkipCheckToUser({
                userId: user.userId,
                reminderType: meal.type,
                title: meal.title,
                body: meal.body,
            });
            dispatched[meal.type] += 1;
        } else if (hour === SUMMARY_HOUR) {
            const claimed = await claimDispatch(user.userId, "summary", localDate);
            if (!claimed) continue;
            const { eligible } = await sendDailySummaryToUser({ userId: user.userId, localDate });
            if (eligible) dispatched.summary += 1;
            // If not eligible (no goal), the claim simply prevents re-checking
            // this user again during today's local-9pm bucket.
        }
    }

    return dispatched;
};

// ---------------------------------------------------------------------------
// Force runners for the manual trigger endpoint (routes/internal.js). These
// IGNORE local time and the dedup log so an admin can fire a job on demand.
// ---------------------------------------------------------------------------
const runMealSkipCheckForce = async ({ reminderType, restrictToUserId = null }) => {
    const def = MEAL_SKIP_CHECKS_BY_TYPE[reminderType];
    if (!def) return { reminderType, recipientCount: 0, sent: 0 };

    let userIds = await getMealReminderEligibleUserIds();
    if (restrictToUserId != null) userIds = userIds.filter((userId) => userId === restrictToUserId);

    let sent = 0;
    for (const userId of userIds) {
        sent += await sendMealSkipCheckToUser({ userId, reminderType, title: def.title, body: def.body });
    }
    return { reminderType, recipientCount: userIds.length, sent };
};

export const runBreakfastReminder = ({ restrictToUserId = null } = {}) =>
    runMealSkipCheckForce({ reminderType: "breakfast", restrictToUserId });
export const runLunchReminder = ({ restrictToUserId = null } = {}) =>
    runMealSkipCheckForce({ reminderType: "lunch", restrictToUserId });
export const runDinnerReminder = ({ restrictToUserId = null } = {}) =>
    runMealSkipCheckForce({ reminderType: "dinner", restrictToUserId });

export const runDailySummary = async ({ restrictToUserId = null } = {}) => {
    let users = await db.select().from(usersTable);
    if (restrictToUserId != null) users = users.filter((user) => user.userId === restrictToUserId);

    let recipientCount = 0;
    let totalSent = 0;
    let skippedMasterDisabled = 0;
    let skippedWithoutNotificationPreference = 0;

    for (const user of users) {
        if (user.notificationsMasterEnabled === false) {
            skippedMasterDisabled += 1;
            continue;
        }
        const { localDate } = getLocalParts(user.timezone);
        const { eligible, sent } = await sendDailySummaryToUser({ userId: user.userId, localDate });
        if (!eligible) {
            skippedWithoutNotificationPreference += 1;
            continue;
        }
        recipientCount += 1;
        totalSent += sent;
    }

    console.log("Manual daily summary completed:", {
        recipientCount,
        totalSent,
        skippedMasterDisabled,
        skippedWithoutNotificationPreference,
        restrictToUserId,
    });

    return { recipientCount, sent: totalSent, skippedMasterDisabled, skippedWithoutNotificationPreference };
};

// The single scheduled job.
const dispatchJob = new cron.CronJob(DISPATCH_CRON, async function () {
    try {
        const result = await runReminderDispatch();
        const total = result.breakfast + result.lunch + result.dinner + result.summary;
        if (total > 0) {
            console.log("Reminder dispatch tick sent notifications:", result);
        }
        // Suppressions are the interesting signal now that skip-checks are
        // conditional — a tick that sends nothing is the expected happy path.
    } catch (error) {
        console.error("Reminder dispatch tick failed:", error);
    }
}, null, false, NOTIFICATION_TIME_ZONE);

const cronManager = {
    start: () => {
        dispatchJob.start();
        console.log("Notification dispatcher started", {
            schedule: DISPATCH_CRON,
            fallbackTimeZone: NOTIFICATION_TIME_ZONE,
            mealSkipChecksLocal: Object.values(MEAL_SKIP_CHECKS_BY_TYPE).map((d) => `${d.type}@${d.hour}:00`),
            summaryHourLocal: SUMMARY_HOUR,
            maxMealNudgesPerDay: MAX_MEAL_NUDGES_PER_DAY,
            note: "Skip-checks fire at each user's LOCAL time (users.timezone) and only when that meal is unlogged",
        });
    },
};

export default cronManager;
