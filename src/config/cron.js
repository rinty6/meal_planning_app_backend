// This file manages the backend's scheduled notification jobs.


import cron from "cron";
import dotenv from "dotenv";
import { db } from "./db.js";
import { usersTable, mealLogsTable, calorieGoalsTable } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { cleanupOldNotifications, sendNotificationToUser, sendNotificationToUsers } from "../services/notificationService.js";


dotenv.config();

const toNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};


// 1. DAILY NOTIFICATION WORKER
// Set to run at 8:00 PM (20:00) Australian Eastern Time every day
const dailyReminderJob = new cron.CronJob("0 12 * * *", async function () {
    console.log("Running Daily Meal Reminder Push...");
    await cleanupOldNotifications();

    const goals = await db.select().from(calorieGoalsTable);
    const userIds = [...new Set(goals.filter((g) => g.notificationsEnabled).map((g) => g.userId))];
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
}, null, true, "Australia/Sydney");

// Set to run at 8:00 PM (20:00) Australian Eastern Time every day
const dailySummaryJob = new cron.CronJob("0 20 * * *", async function () {
    console.log("Running Daily Calorie Summary Check for Aussies...");
   
    // Explicitly grab the current date for Sydney
    const aussieDate = new Intl.DateTimeFormat('en-AU', {
        timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
   
    // Format to YYYY-MM-DD for database query
    const [day, month, year] = aussieDate.split('/');
    const today = `${year}-${month}-${day}`;


    const users = await db.select().from(usersTable);


    for (const user of users) {
        const goalData = await db.select().from(calorieGoalsTable)
            .where(eq(calorieGoalsTable.userId, user.userId)).limit(1);
       
        if (goalData.length === 0 || !goalData[0].notificationsEnabled) continue;
       
        const target = toNumber(goalData[0].dailyCalories) || 2000;


        const meals = await db.select().from(mealLogsTable)
            .where(and(eq(mealLogsTable.userId, user.userId), eq(mealLogsTable.date, today)));
           
        const consumed = meals.reduce((sum, meal) => sum + toNumber(meal.calories), 0);


        let title = consumed > target ? "Calorie Update 🚨" : "Great Job! 🎉";
        let body = consumed > target
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
    }
}, null, true, 'Australia/Sydney'); 


const cronManager = {
    start: () => {
        dailyReminderJob.start();
        dailySummaryJob.start();
    }
};


export default cronManager;
