// This route handles meal logging, summary retrieval, and recent-meal history.

import express from "express";
import { db } from "../config/db.js";
import { mealLogsTable, usersTable, calorieGoalsTable } from "../db/schema.js";
import { eq, and, desc, lte, gte } from "drizzle-orm";
import { sendNotificationToUser } from "../services/notificationService.js";
import { getMostConsumedForUser } from "../services/mostConsumedMeals.js";

const mealRoutes = express.Router();

const normalizeDateString = (rawDate) => {
  if (typeof rawDate !== "string") return null;
  const dateStr = rawDate.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : null;
};

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const getUserByClerkId = async (clerkId) => {
  const user = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId)).limit(1);
  return user.length > 0 ? user[0] : null;
};

const getActiveGoalForDate = async (userId, dateStr) => {
  const activeGoals = await db
    .select()
    .from(calorieGoalsTable)
    .where(and(eq(calorieGoalsTable.userId, userId), lte(calorieGoalsTable.startDate, dateStr), gte(calorieGoalsTable.endDate, dateStr)))
    .orderBy(desc(calorieGoalsTable.createdAt))
    .limit(1);

  if (activeGoals.length > 0) return activeGoals[0];

  return {
    dailyCalories: 2000,
    notificationsEnabled: false,
  };
};

mealRoutes.post("/add", async (req, res) => {
  try {
    const {
      clerkId,
      date,
      mealType,
      foodName,
      calories,
      protein,
      carbs,
      fats,
      image,
      externalId,
      source,
      servingId,
      servingDescription,
      nutrients,
    } = req.body;
    const dateStr = normalizeDateString(date);
    if (!dateStr) return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });

    const user = await getUserByClerkId(clerkId);
    if (!user) return res.status(404).json({ error: "User not found" });

    await db.insert(mealLogsTable).values({
      userId: user.userId,
      date: dateStr,
      mealType,
      foodName,
      calories: toNumber(calories),
      protein: toNumber(protein),
      carbs: toNumber(carbs),
      fats: toNumber(fats),
      image: image || "",
      externalId: externalId ? String(externalId) : null,
      source: source ? String(source) : null,
      servingId: servingId ? String(servingId) : null,
      servingDescription: servingDescription ? String(servingDescription) : null,
      nutrients: nutrients && typeof nutrients === "object" ? nutrients : {},
    });

    const goal = await getActiveGoalForDate(user.userId, dateStr);
    const target = toNumber(goal.dailyCalories) || 2000;

    const meals = await db
      .select()
      .from(mealLogsTable)
      .where(and(eq(mealLogsTable.userId, user.userId), eq(mealLogsTable.date, dateStr)));

    const newTotalCalories = meals.reduce((sum, m) => sum + toNumber(m.calories), 0);
    const previousTotalCalories = Math.max(0, newTotalCalories - toNumber(calories));
    const reachedTarget = newTotalCalories >= target && previousTotalCalories < target;
    const exceededLimit = newTotalCalories > target;

    // Send push + save inbox history once when crossing the target threshold for the day.
    if (goal.notificationsEnabled && reachedTarget) {
      await sendNotificationToUser({
        userId: user.userId,
        title: "Daily Goal Achieved!",
        body: `Congratulations! You've met your calorie target of ${target} kcal today.`,
        data: { screen: "/(tabs)/profile/notifications", type: "goal_achieved" },
      });
    }

    res.status(201).json({
      success: true,
      message: "Meal added successfully",
      reachedTarget,
      exceededLimit,
      dailyTotalCalories: Math.round(newTotalCalories),
      dailyTarget: target,
    });
  } catch (error) {
    console.error("Error adding meal:", error);
    res.status(500).json({ error: "Failed to add meal" });
  }
});

mealRoutes.post("/add-batch", async (req, res) => {
  try {
    const { clerkId, date, mealType, items } = req.body;
    const dateStr = normalizeDateString(date);
    if (!dateStr) return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "At least one meal item is required" });
    }

    const user = await getUserByClerkId(clerkId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const mealRows = items.map((item) => ({
      userId: user.userId,
      date: dateStr,
      mealType,
      foodName: String(item?.foodName || "Unknown Item").trim() || "Unknown Item",
      calories: toNumber(item?.calories),
      protein: toNumber(item?.protein),
      carbs: toNumber(item?.carbs),
      fats: toNumber(item?.fats),
      image: item?.image || "",
      externalId: item?.externalId ? String(item.externalId) : null,
      source: item?.source ? String(item.source) : null,
      servingId: item?.servingId ? String(item.servingId) : null,
      servingDescription: item?.servingDescription ? String(item.servingDescription) : null,
      nutrients: item?.nutrients && typeof item.nutrients === "object" ? item.nutrients : {},
    }));

    await db.insert(mealLogsTable).values(mealRows);

    const goal = await getActiveGoalForDate(user.userId, dateStr);
    const target = toNumber(goal.dailyCalories) || 2000;

    const meals = await db
      .select()
      .from(mealLogsTable)
      .where(and(eq(mealLogsTable.userId, user.userId), eq(mealLogsTable.date, dateStr)));

    const addedCalories = mealRows.reduce((sum, item) => sum + toNumber(item.calories), 0);
    const newTotalCalories = meals.reduce((sum, m) => sum + toNumber(m.calories), 0);
    const previousTotalCalories = Math.max(0, newTotalCalories - addedCalories);
    const reachedTarget = newTotalCalories >= target && previousTotalCalories < target;
    const exceededLimit = newTotalCalories > target;

    if (goal.notificationsEnabled && reachedTarget) {
      await sendNotificationToUser({
        userId: user.userId,
        title: "Daily Goal Achieved!",
        body: `Congratulations! You've met your calorie target of ${target} kcal today.`,
        data: { screen: "/(tabs)/profile/notifications", type: "goal_achieved" },
      });
    }

    res.status(201).json({
      success: true,
      message: "Meal added successfully",
      reachedTarget,
      exceededLimit,
      dailyTotalCalories: Math.round(newTotalCalories),
      dailyTarget: target,
      addedCount: mealRows.length,
    });
  } catch (error) {
    console.error("Error adding meals batch:", error);
    res.status(500).json({ error: "Failed to add meals" });
  }
});

mealRoutes.get("/summary/:clerkId/:date", async (req, res) => {
  try {
    const { clerkId, date } = req.params;
    const dateStr = normalizeDateString(date);
    if (!dateStr) return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });

    const user = await getUserByClerkId(clerkId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const meals = await db
      .select()
      .from(mealLogsTable)
      .where(and(eq(mealLogsTable.userId, user.userId), eq(mealLogsTable.date, dateStr)));

    res.status(200).json(meals);
  } catch (error) {
    console.error("Error fetching summary:", error);
    res.status(500).json({ error: "Failed to fetch meals" });
  }
});

mealRoutes.delete("/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.delete(mealLogsTable).where(eq(mealLogsTable.id, id));
    res.status(200).json({ success: true, message: "Item deleted" });
  } catch (error) {
    console.error("Error deleting item:", error);
    res.status(500).json({ error: "Failed to delete" });
  }
});

// Aggregates the user's full meal history into a "most consumed" list directly
// from Postgres. This intentionally matches the SQL grouped count by food_name.
// The recommendation route's `most_consumed_items` field depends on
// the ML service successfully fetching history_df via DB_URL — when that fails
// silently (env not set, transient outage), the strip on the meal planner stays
// empty. Computing it here keeps the UI populated as long as Node can read
// meal_logs.
mealRoutes.get("/most-consumed/:clerkId", async (req, res) => {
  try {
    const { clerkId } = req.params;
    const limit = Math.max(1, Math.min(20, Number(req.query.limit) || 10));

    const user = await getUserByClerkId(clerkId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const mostConsumed = await getMostConsumedForUser(user.userId, { limit });

    res.status(200).json({ items: mostConsumed.all });
  } catch (error) {
    console.error("Error fetching most-consumed meals:", error);
    res.status(500).json({ error: "Failed to fetch most-consumed meals" });
  }
});

mealRoutes.get("/recent/:clerkId", async (req, res) => {
  try {
    const { clerkId } = req.params;
    const user = await getUserByClerkId(clerkId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const meals = await db
      .select()
      .from(mealLogsTable)
      .where(eq(mealLogsTable.userId, user.userId))
      .orderBy(desc(mealLogsTable.createdAt))
      .limit(50);

    const recent = { breakfast: [], lunch: [], dinner: [] };
    const seen = new Set();

    for (const meal of meals) {
      if (!["breakfast", "lunch", "dinner"].includes(meal.mealType)) continue;
      const key = `${meal.mealType}-${meal.foodName.toLowerCase().trim()}`;

      if (!seen.has(key)) {
        seen.add(key);
        if (recent[meal.mealType].length < 5) recent[meal.mealType].push(meal);
      }
    }

    res.status(200).json(recent);
  } catch (error) {
    console.error("Error fetching recent meals:", error);
    res.status(500).json({ error: "Failed to fetch recent meals" });
  }
});

export default mealRoutes;
