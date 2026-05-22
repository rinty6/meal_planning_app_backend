import cron from "cron";
import dotenv from "dotenv";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db } from "./db.js";
import { calorieGoalsTable, mealLogsTable, userDevicesTable, usersTable } from "../db/schema.js";
import {
    cleanupOldNotifications,
    sendNotificationToUser,
    sendNotificationToUsers,
} from "../services/notificationService.js";

dotenv.config();

const NOTIFICATION_TIME_ZONE = process.env.NOTIFICATION_TIME_ZONE || "Australia/Adelaide";
const LUNCH_REMINDER_CRON = "0 12 * * *";
const DINNER_REMINDER_CRON = "0 18 * * *";
const DAILY_SUMMARY_CRON = "0 20 * * *";

const toNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

const getLocalYYYYMMDD = () => {
    const localDate = new Intl.DateTimeFormat("en-AU", {
        timeZone: NOTIFICATION_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date());
    const [day, month, year] = localDate.split("/");
    return `${year}-${month}-${day}`;
};

const getActiveNotificationGoals = async (dateStr) => {
    return db
        .select()
        .from(calorieGoalsTable)
        .where(
            and(
                eq(calorieGoalsTable.notificationsEnabled, true),
                lte(calorieGoalsTable.startDate, dateStr),
                gte(calorieGoalsTable.endDate, dateStr)
            )
        )
        .orderBy(desc(calorieGoalsTable.createdAt));
};

const getLatestNotificationGoalForUser = async (userId) => {
    const goals = await db
        .select()
        .from(calorieGoalsTable)
        .where(eq(calorieGoalsTable.userId, userId))
        .orderBy(desc(calorieGoalsTable.createdAt))
        .limit(1);

    const goal = goals[0] || null;
    return goal?.notificationsEnabled ? goal : null;
};

const getReminderUserIds = async () => {
    const deviceRows = await db
        .select({ userId: userDevicesTable.userId })
        .from(userDevicesTable);
    const usersWithDevices = new Set(deviceRows.map((row) => row.userId).filter(Boolean));
    if (usersWithDevices.size === 0) return [];

    const goals = await db
        .select({
            userId: calorieGoalsTable.userId,
            notificationsEnabled: calorieGoalsTable.notificationsEnabled,
        })
        .from(calorieGoalsTable)
        .orderBy(desc(calorieGoalsTable.createdAt));

    const latestPreferenceByUser = new Map();
    for (const goal of goals) {
        if (latestPreferenceByUser.has(goal.userId)) continue;
        latestPreferenceByUser.set(goal.userId, Boolean(goal.notificationsEnabled));
    }

    return [...usersWithDevices].filter((userId) => latestPreferenceByUser.get(userId) === true);
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

const sendMealReminder = async ({ mealType, title, body }) => {
    await cleanupOldNotifications();

    const today = getLocalYYYYMMDD();
    const activeGoals = await getActiveNotificationGoals(today);
    const userIds = await getReminderUserIds();

    console.log("Daily meal reminder notification users:", {
        date: today,
        mealType,
        count: userIds.length,
        activeGoalCount: activeGoals.length,
    });

    if (userIds.length === 0) return;

    await sendNotificationToUsers({
        userIds,
        title,
        body,
        data: {
            type: `${mealType}_reminder`,
            mealType,
            screen: "/(tabs)/meal/summary",
        },
    });
};

// Runs at 12:00 PM in the configured notification time zone.
const lunchReminderJob = new cron.CronJob(LUNCH_REMINDER_CRON, async function () {
    console.log("Running Lunch Meal Reminder Push...");
    await sendMealReminder({
        mealType: "lunch",
        title: "Lunch Reminder",
        body: "Don't forget to log your lunch. Stay on track with your goals!",
    });
}, null, false, NOTIFICATION_TIME_ZONE);

// Runs at 6:00 PM in the configured notification time zone.
const dinnerReminderJob = new cron.CronJob(DINNER_REMINDER_CRON, async function () {
    console.log("Running Dinner Meal Reminder Push...");
    await sendMealReminder({
        mealType: "dinner",
        title: "Dinner Reminder",
        body: "Don't forget to log your dinner. Finish the day strong!",
    });
}, null, false, NOTIFICATION_TIME_ZONE);

// Runs at 8:00 PM in the configured notification time zone.
const dailySummaryJob = new cron.CronJob(DAILY_SUMMARY_CRON, async function () {
    console.log("Running Daily Calorie Summary Check...");
    const today = getLocalYYYYMMDD();
    const users = await db.select().from(usersTable);
    let sentCount = 0;
    let skippedWithoutNotificationPreference = 0;

    for (const user of users) {
        const goal =
            (await getLatestActiveNotificationGoalForUser(user.userId, today)) ||
            (await getLatestNotificationGoalForUser(user.userId));
        if (!goal) {
            skippedWithoutNotificationPreference += 1;
            continue;
        }

        const target = toNumber(goal.dailyCalories) || 2000;
        const meals = await db
            .select()
            .from(mealLogsTable)
            .where(and(eq(mealLogsTable.userId, user.userId), eq(mealLogsTable.date, today)));

        const consumed = meals.reduce((sum, meal) => sum + toNumber(meal.calories), 0);
        const title = consumed > target ? "Calorie Update" : "Great Job!";
        const body = consumed > target
            ? `You went ${Math.round(consumed - target)} kcal over your goal. Tomorrow is a new day!`
            : `You stayed under your goal of ${target} kcal. Keep it up!`;

        await sendNotificationToUser({
            userId: user.userId,
            title,
            body,
            data: {
                type: "daily_summary",
                date: today,
                screen: "/(tabs)/profile/notifications",
            },
        });

        sentCount += 1;
    }

    console.log("Daily calorie summary completed:", {
        date: today,
        totalUsers: users.length,
        sentCount,
        skippedWithoutNotificationPreference,
    });
}, null, false, NOTIFICATION_TIME_ZONE);

const cronManager = {
    start: () => {
        lunchReminderJob.start();
        dinnerReminderJob.start();
        dailySummaryJob.start();
        console.log("Notification cron jobs started", {
            timeZone: NOTIFICATION_TIME_ZONE,
            lunchReminder: "12:00",
            lunchReminderCron: LUNCH_REMINDER_CRON,
            dinnerReminder: "18:00",
            dinnerReminderCron: DINNER_REMINDER_CRON,
            dailySummary: "20:00",
            dailySummaryCron: DAILY_SUMMARY_CRON,
        });
    },
};

export default cronManager;
