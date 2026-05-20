import cron from "cron";
import dotenv from "dotenv";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db } from "./db.js";
import { calorieGoalsTable, mealLogsTable, usersTable } from "../db/schema.js";
import {
    cleanupOldNotifications,
    sendNotificationToUser,
    sendNotificationToUsers,
} from "../services/notificationService.js";

dotenv.config();

const NOTIFICATION_TIME_ZONE = process.env.NOTIFICATION_TIME_ZONE || "Australia/Adelaide";
const DAILY_REMINDER_CRON = "0 12 * * *";
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

// Runs at 12:00 PM in the configured notification time zone.
const dailyReminderJob = new cron.CronJob(DAILY_REMINDER_CRON, async function () {
    console.log("Running Daily Meal Reminder Push...");
    await cleanupOldNotifications();

    const today = getLocalYYYYMMDD();
    const goals = await getActiveNotificationGoals(today);
    const userIds = [...new Set(goals.map((goal) => goal.userId))];

    console.log("Daily reminder active notification users:", {
        date: today,
        count: userIds.length,
    });

    if (userIds.length === 0) return;

    await sendNotificationToUsers({
        userIds,
        title: "Meal Reminder",
        body: "Don't forget to log your lunch. Stay on track with your goals!",
        data: {
            type: "daily_reminder",
            screen: "/(tabs)/meal/summary",
        },
    });
}, null, false, NOTIFICATION_TIME_ZONE);

// Runs at 8:00 PM in the configured notification time zone.
const dailySummaryJob = new cron.CronJob(DAILY_SUMMARY_CRON, async function () {
    console.log("Running Daily Calorie Summary Check...");
    const today = getLocalYYYYMMDD();
    const users = await db.select().from(usersTable);
    let sentCount = 0;
    let skippedWithoutActiveGoal = 0;

    for (const user of users) {
        const goal = await getLatestActiveNotificationGoalForUser(user.userId, today);
        if (!goal) {
            skippedWithoutActiveGoal += 1;
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
        skippedWithoutActiveGoal,
    });
}, null, false, NOTIFICATION_TIME_ZONE);

const cronManager = {
    start: () => {
        dailyReminderJob.start();
        dailySummaryJob.start();
        console.log("Notification cron jobs started", {
            timeZone: NOTIFICATION_TIME_ZONE,
            dailyReminder: "12:00",
            dailyReminderCron: DAILY_REMINDER_CRON,
            dailySummary: "20:00",
            dailySummaryCron: DAILY_SUMMARY_CRON,
        });
    },
};

export default cronManager;
