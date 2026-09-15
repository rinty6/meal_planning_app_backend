// Diagnostic: replicate the EXACT recipient-selection logic the cron uses,
// without sending anything. This tells us whether your account is even
// SELECTED as a reminder recipient. Delivery is already proven healthy
// (test-push.js returned ok tickets + ok receipts), so the break is here
// or in the cron firing on Railway.
//
// Usage (from backend/ so it reads backend/.env):
//   node scripts/diagnose-reminders.js <your-clerk-id>
//   node scripts/diagnose-reminders.js            -> dumps the whole recipient set

import "dotenv/config";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db } from "../src/config/db.js";
import { calorieGoalsTable, userDevicesTable, usersTable } from "../src/db/schema.js";

const NOTIFICATION_TIME_ZONE = process.env.NOTIFICATION_TIME_ZONE || "Australia/Adelaide";

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

// Copy of cron.js getReminderUserIds()
const getReminderUserIds = async () => {
  const deviceRows = await db.select({ userId: userDevicesTable.userId }).from(userDevicesTable);
  const usersWithDevices = new Set(deviceRows.map((r) => r.userId).filter(Boolean));
  if (usersWithDevices.size === 0) return [];

  const goals = await db
    .select({ userId: calorieGoalsTable.userId, notificationsEnabled: calorieGoalsTable.notificationsEnabled })
    .from(calorieGoalsTable)
    .orderBy(desc(calorieGoalsTable.createdAt));

  const latestPreferenceByUser = new Map();
  for (const goal of goals) {
    if (latestPreferenceByUser.has(goal.userId)) continue;
    latestPreferenceByUser.set(goal.userId, Boolean(goal.notificationsEnabled));
  }
  return [...usersWithDevices].filter((userId) => latestPreferenceByUser.get(userId) === true);
};

async function main() {
  const clerkId = process.argv[2];
  const today = getLocalYYYYMMDD();
  console.log("[diagnose] timezone:", NOTIFICATION_TIME_ZONE, "| local 'today':", today);

  const reminderUserIds = await getReminderUserIds();
  console.log(`[diagnose] LUNCH/DINNER reminder recipient userIds (${reminderUserIds.length}):`, reminderUserIds);

  if (!clerkId) {
    console.log("[diagnose] No clerkId passed — stopping after the global recipient set.");
    process.exit(0);
  }

  const userRows = await db
    .select({ userId: usersTable.userId, clerkId: usersTable.clerkId })
    .from(usersTable)
    .where(eq(usersTable.clerkId, clerkId));
  const user = userRows[0];
  if (!user) {
    console.log("[diagnose] No user_info row for that clerkId.");
    process.exit(0);
  }
  console.log("[diagnose] internal userId:", user.userId);

  const devices = await db
    .select({ platform: userDevicesTable.platform, updatedAt: userDevicesTable.updatedAt })
    .from(userDevicesTable)
    .where(eq(userDevicesTable.userId, user.userId));
  console.log(`[diagnose] devices for this user: ${devices.length}`, devices);

  const goals = await db
    .select()
    .from(calorieGoalsTable)
    .where(eq(calorieGoalsTable.userId, user.userId))
    .orderBy(desc(calorieGoalsTable.createdAt));
  console.log(`[diagnose] calorie goals for this user (newest first): ${goals.length}`);
  goals.forEach((g, i) => {
    console.log(
      `  [${i}] createdAt=${g.createdAt} notificationsEnabled=${g.notificationsEnabled} ` +
        `startDate=${g.startDate} endDate=${g.endDate} dailyCalories=${g.dailyCalories}`
    );
  });

  const latest = goals[0];
  const isSelectedForReminders = reminderUserIds.includes(user.userId);
  console.log("\n[diagnose] ===== VERDICT =====");
  console.log("  has device(s):", devices.length > 0);
  console.log("  latest goal exists:", Boolean(latest));
  console.log("  latest goal notificationsEnabled:", latest ? Boolean(latest.notificationsEnabled) : "(no goal)");
  if (latest) {
    const inWindow = latest.startDate <= today && latest.endDate >= today;
    console.log(`  latest goal active today (${latest.startDate}..${latest.endDate} vs ${today}):`, inWindow);
  }
  console.log("  >>> SELECTED for lunch/dinner reminders:", isSelectedForReminders);
  console.log("      (daily 8pm summary uses latest-active-OR-latest-notification goal, so it follows the same flag.)");
  process.exit(0);
}

main().catch((err) => {
  console.error("[diagnose] FAILED:", err);
  process.exit(1);
});
