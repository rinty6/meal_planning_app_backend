import cron from "cron";
import dotenv from "dotenv";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db } from "./db.js";
import {
    calorieGoalsTable,
    mealLogsTable,
    notificationDispatchLogTable,
    userDevicesTable,
    usersTable,
} from "../db/schema.js";
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

// Meal reminders are keyed by LOCAL hour and are INDEPENDENT of any calorie goal
// (Phase 3 decoupling). They require only: a device + the master switch on.
const MEAL_REMINDERS_BY_HOUR = {
    8: { type: "breakfast", title: "Breakfast Reminder", body: "Don't forget to log your breakfast. Start your day on track!" },
    12: { type: "lunch", title: "Lunch Reminder", body: "Don't forget to log your lunch. Stay on track with your goals!" },
    18: { type: "dinner", title: "Dinner Reminder", body: "Don't forget to log your dinner. Finish the day strong!" },
};
const MEAL_REMINDERS_BY_TYPE = Object.fromEntries(
    Object.entries(MEAL_REMINDERS_BY_HOUR).map(([hour, def]) => [def.type, { hour: Number(hour), ...def }])
);

// The 20:00 calorie summary still requires a notification-enabled calorie goal.
const SUMMARY_HOUR = 20;

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

const sendMealReminderToUser = async ({ userId, reminderType, title, body }) => {
    const result = await sendNotificationToUser({
        userId,
        title,
        body,
        data: { type: `${reminderType}_reminder`, mealType: reminderType, screen: "/(tabs)/meal/summary" },
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
    const title = consumed > target ? "Calorie Update" : "Great Job!";
    const body = consumed > target
        ? `You went ${Math.round(consumed - target)} kcal over your goal. Tomorrow is a new day!`
        : `You stayed under your goal of ${target} kcal. Keep it up!`;

    const result = await sendNotificationToUser({
        userId,
        title,
        body,
        data: { type: "daily_summary", date: localDate, screen: "/(tabs)/profile/notifications" },
    });
    return { eligible: true, sent: result?.sent ?? 0 };
};

// ---------------------------------------------------------------------------
// The dispatcher — runs every 15 min, sends each due reminder at LOCAL time.
// ---------------------------------------------------------------------------
export const runReminderDispatch = async ({ restrictToUserId = null } = {}) => {
    await cleanupOldNotifications();
    await cleanupOldDispatchLogs();

    const eligibleIds = new Set(await getMealReminderEligibleUserIds());
    let users = await db
        .select({ userId: usersTable.userId, timezone: usersTable.timezone })
        .from(usersTable);
    users = users.filter((user) => eligibleIds.has(user.userId));
    if (restrictToUserId != null) users = users.filter((user) => user.userId === restrictToUserId);

    const dispatched = { breakfast: 0, lunch: 0, dinner: 0, summary: 0 };

    for (const user of users) {
        const { localDate, hour, minute } = getLocalParts(user.timezone);
        if (minute >= DISPATCH_WINDOW_MINUTES) continue; // only the top-of-hour bucket

        const meal = MEAL_REMINDERS_BY_HOUR[hour];
        if (meal) {
            const claimed = await claimDispatch(user.userId, meal.type, localDate);
            if (!claimed) continue;
            await sendMealReminderToUser({
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
            // this user again during today's local-8pm bucket.
        }
    }

    return dispatched;
};

// ---------------------------------------------------------------------------
// Force runners for the manual trigger endpoint (routes/internal.js). These
// IGNORE local time and the dedup log so an admin can fire a job on demand.
// ---------------------------------------------------------------------------
const runMealReminderForce = async ({ reminderType, restrictToUserId = null }) => {
    const def = MEAL_REMINDERS_BY_TYPE[reminderType];
    if (!def) return { reminderType, recipientCount: 0, sent: 0 };

    let userIds = await getMealReminderEligibleUserIds();
    if (restrictToUserId != null) userIds = userIds.filter((userId) => userId === restrictToUserId);

    let sent = 0;
    for (const userId of userIds) {
        sent += await sendMealReminderToUser({ userId, reminderType, title: def.title, body: def.body });
    }
    return { reminderType, recipientCount: userIds.length, sent };
};

export const runBreakfastReminder = ({ restrictToUserId = null } = {}) =>
    runMealReminderForce({ reminderType: "breakfast", restrictToUserId });
export const runLunchReminder = ({ restrictToUserId = null } = {}) =>
    runMealReminderForce({ reminderType: "lunch", restrictToUserId });
export const runDinnerReminder = ({ restrictToUserId = null } = {}) =>
    runMealReminderForce({ reminderType: "dinner", restrictToUserId });

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
            mealRemindersLocal: Object.values(MEAL_REMINDERS_BY_TYPE).map((d) => `${d.type}@${d.hour}:00`),
            summaryHourLocal: SUMMARY_HOUR,
            note: "Reminders fire at each user's LOCAL time using users.timezone",
        });
    },
};

export default cronManager;
