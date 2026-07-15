// This route handles meal logging, summary retrieval, and recent-meal history.
// Meal-add responses and threshold notifications use the shared date-aware target,
// so an expired goal falls back to the onboarding estimate instead of stale/2000 data.

import express from "express";
import { db } from "../config/db.js";
import { mealLogsTable } from "../db/schema.js";
import { eq, and, desc } from "drizzle-orm";
import { getDailyCalorieTargetContext } from "../services/dailyCalorieTarget.js";
import { sendNotificationToUser } from "../services/notificationService.js";
import { getMostConsumedForUser } from "../services/mostConsumedMeals.js";
import { requireClerkAuth, ensureClerkIdMatch, attachUserFromAuth } from "../middleware/auth.js";

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

const parsePositiveIntegerId = (value) => {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

mealRoutes.post("/add", requireClerkAuth, ensureClerkIdMatch("body"), attachUserFromAuth, async (req, res) => {
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
      servings,
      nutrients,
    } = req.body;
    const dateStr = normalizeDateString(date);
    if (!dateStr) return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });

    const user = req.dbUser;

    const insertedMeals = await db.insert(mealLogsTable).values({
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
      servings: toNumber(servings) > 0 ? toNumber(servings) : 1,
      nutrients: nutrients && typeof nutrients === "object" ? nutrients : {},
    }).returning();
    const meal = insertedMeals[0] || null;

    // Resolve the exact target shown by Home/Summary before calculating whether
    // this add crossed the user's active threshold.
    const targetContext = await getDailyCalorieTargetContext({ db, userId: user.userId, dateStr });
    const target = targetContext.dailyCalories;
    const activeGoal = targetContext.source === "goal" ? targetContext.goalRecord : null;

    const meals = await db
      .select()
      .from(mealLogsTable)
      .where(and(eq(mealLogsTable.userId, user.userId), eq(mealLogsTable.date, dateStr)));

    const newTotalCalories = meals.reduce((sum, m) => sum + toNumber(m.calories), 0);
    const previousTotalCalories = Math.max(0, newTotalCalories - toNumber(calories));
    const reachedTarget = newTotalCalories >= target && previousTotalCalories < target;
    const exceededLimit = newTotalCalories > target;

    // Send push + save inbox history once when crossing the target threshold for the day.
    if (user.notificationsMasterEnabled !== false && activeGoal?.notificationsEnabled && reachedTarget) {
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
      dailyTargetSource: targetContext.source,
      meal,
    });
  } catch (error) {
    console.error("Error adding meal:", error);
    res.status(500).json({ error: "Failed to add meal" });
  }
});

mealRoutes.post("/add-batch", requireClerkAuth, ensureClerkIdMatch("body"), attachUserFromAuth, async (req, res) => {
  try {
    const { clerkId, date, mealType, items } = req.body;
    const dateStr = normalizeDateString(date);
    if (!dateStr) return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "At least one meal item is required" });
    }

    const user = req.dbUser;

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
      servings: toNumber(item?.servings) > 0 ? toNumber(item?.servings) : 1,
      nutrients: item?.nutrients && typeof item.nutrients === "object" ? item.nutrients : {},
    }));

    await db.insert(mealLogsTable).values(mealRows);

    // Batch adds follow the same policy as single adds; only a real active goal
    // may trigger a notification, while BMR/default targets still drive progress.
    const targetContext = await getDailyCalorieTargetContext({ db, userId: user.userId, dateStr });
    const target = targetContext.dailyCalories;
    const activeGoal = targetContext.source === "goal" ? targetContext.goalRecord : null;

    const meals = await db
      .select()
      .from(mealLogsTable)
      .where(and(eq(mealLogsTable.userId, user.userId), eq(mealLogsTable.date, dateStr)));

    const addedCalories = mealRows.reduce((sum, item) => sum + toNumber(item.calories), 0);
    const newTotalCalories = meals.reduce((sum, m) => sum + toNumber(m.calories), 0);
    const previousTotalCalories = Math.max(0, newTotalCalories - addedCalories);
    const reachedTarget = newTotalCalories >= target && previousTotalCalories < target;
    const exceededLimit = newTotalCalories > target;

    if (user.notificationsMasterEnabled !== false && activeGoal?.notificationsEnabled && reachedTarget) {
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
      dailyTargetSource: targetContext.source,
      addedCount: mealRows.length,
    });
  } catch (error) {
    console.error("Error adding meals batch:", error);
    res.status(500).json({ error: "Failed to add meals" });
  }
});

mealRoutes.get("/summary/:clerkId/:date", requireClerkAuth, ensureClerkIdMatch("params"), attachUserFromAuth, async (req, res) => {
  try {
    const { clerkId, date } = req.params;
    const dateStr = normalizeDateString(date);
    if (!dateStr) return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });

    const user = req.dbUser;

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

mealRoutes.delete("/delete/:id", requireClerkAuth, attachUserFromAuth, async (req, res) => {
  try {
    const id = parsePositiveIntegerId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: "Invalid meal log id" });
    }
    const deleted = await db
      .delete(mealLogsTable)
      .where(and(eq(mealLogsTable.id, id), eq(mealLogsTable.userId, req.dbUser.userId)))
      .returning();
    if (deleted.length === 0) {
      return res.status(404).json({ error: "Meal not found" });
    }
    res.status(200).json({ success: true, message: "Item deleted" });
  } catch (error) {
    console.error("Error deleting item:", error);
    res.status(500).json({ error: "Failed to delete" });
  }
});

// Update a logged meal's servings and its (already-scaled) macros — used by the
// meal summary +/- controls. The client sends the new totals it computed from
// per-serving x servings, so daily calorie sums stay consistent with what's shown.
mealRoutes.put("/update/:id", requireClerkAuth, attachUserFromAuth, async (req, res) => {
  try {
    const id = parsePositiveIntegerId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid meal log id" });

    const { servings, calories, protein, carbs, fats, servingDescription } = req.body;
    const safeServings = toNumber(servings) > 0 ? toNumber(servings) : 1;

    const updateValues = {
      servings: safeServings,
      calories: toNumber(calories),
      protein: toNumber(protein),
      carbs: toNumber(carbs),
      fats: toNumber(fats),
    };
    if (servingDescription !== undefined) {
      updateValues.servingDescription = servingDescription ? String(servingDescription) : null;
    }

    const updated = await db
      .update(mealLogsTable)
      .set(updateValues)
      .where(and(eq(mealLogsTable.id, id), eq(mealLogsTable.userId, req.dbUser.userId)))
      .returning();

    if (updated.length === 0) {
      return res.status(404).json({ error: "Meal not found" });
    }
    res.status(200).json({ success: true, meal: updated[0] });
  } catch (error) {
    console.error("Error updating meal:", error);
    res.status(500).json({ error: "Failed to update meal" });
  }
});

// Aggregates the user's full meal history into a "most consumed" list directly
// from Postgres. This intentionally matches the SQL grouped count by food_name.
// The recommendation route's `most_consumed_items` field depends on
// the ML service successfully fetching history_df via DB_URL — when that fails
// silently (env not set, transient outage), the strip on the meal planner stays
// empty. Computing it here keeps the UI populated as long as Node can read
// meal_logs.
mealRoutes.get("/most-consumed/:clerkId", requireClerkAuth, ensureClerkIdMatch("params"), attachUserFromAuth, async (req, res) => {
  try {
    const { clerkId } = req.params;
    const limit = Math.max(1, Math.min(20, Number(req.query.limit) || 10));

    const user = req.dbUser;

    const mostConsumed = await getMostConsumedForUser(user.userId, { limit });

    res.status(200).json({ items: mostConsumed.all });
  } catch (error) {
    console.error("Error fetching most-consumed meals:", error);
    res.status(500).json({ error: "Failed to fetch most-consumed meals" });
  }
});

mealRoutes.get("/recent/:clerkId", requireClerkAuth, ensureClerkIdMatch("params"), attachUserFromAuth, async (req, res) => {
  try {
    const user = req.dbUser;

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
