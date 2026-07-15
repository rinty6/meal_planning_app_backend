// This route handles calorie goal management, daily summaries, and weekly history.
// Target selection is intentionally delegated to dailyCalorieTarget.js so these
// payloads use the same active-goal/onboarding/default rules as Meal Planning.

import express from "express";
import { db } from "../config/db.js";
import { calorieGoalsTable, mealLogsTable, demographicsTable } from "../db/schema.js";
import { and, lte, gte, desc, eq } from "drizzle-orm";
import { buildCalorieInsights } from "../services/calorieInsights.js";
import {
  DEFAULT_DAILY_CALORIES,
  MIN_DAILY_CALORIES,
  getDailyCalorieTargetContext,
} from "../services/dailyCalorieTarget.js";
import { requireClerkAuth, ensureClerkIdMatch, attachUserFromAuth } from "../middleware/auth.js";

const calorieRoutes = express.Router();

const normalizeDateString = (rawDate) => {
  if (typeof rawDate !== "string") return null;
  const dateStr = rawDate.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : null;
};

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const selectMacroRatios = ({ goal, activityLevel }) => {
  const level = activityLevel || "moderately_active";

  // Ratios are selected within the requested ranges based on activity level.
  if (goal === "lose_weight") {
    if (level === "lightly_active") return { protein: 0.35, carbs: 0.35, fats: 0.3 };
    if (level === "very_active" || level === "super_active") return { protein: 0.3, carbs: 0.4, fats: 0.3 };
    return { protein: 0.33, carbs: 0.37, fats: 0.3 };
  }

  // "maintain" and "gain_muscle" both use the maintenance range by default.
  if (level === "lightly_active") return { protein: 0.3, carbs: 0.4, fats: 0.3 };
  if (level === "very_active" || level === "super_active") return { protein: 0.25, carbs: 0.45, fats: 0.3 };
  return { protein: 0.28, carbs: 0.43, fats: 0.29 };
};

const calculateMacronutrientTargets = ({ calorieTarget, goal, activityLevel }) => {
  const safeCalories = Math.max(0, toNumber(calorieTarget));
  const ratios = selectMacroRatios({ goal, activityLevel });

  const protein = Math.round((safeCalories * ratios.protein) / 4);
  const carbs = Math.round((safeCalories * ratios.carbs) / 4);
  const fats = Math.round((safeCalories * ratios.fats) / 9);

  return {
    ratios: {
      proteinPct: Math.round(ratios.protein * 100),
      carbsPct: Math.round(ratios.carbs * 100),
      fatsPct: Math.round(ratios.fats * 100),
    },
    grams: { protein, carbs, fats },
  };
};

const getLocalYYYYMMDD = (d) => {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const normalizeMealDateKey = (value) => {
  if (!value) return null;
  if (value instanceof Date) return getLocalYYYYMMDD(value);

  if (typeof value === "string") {
    const cleaned = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;
    if (cleaned.includes("T")) {
      const parsed = new Date(cleaned);
      if (!Number.isNaN(parsed.getTime())) return getLocalYYYYMMDD(parsed);
    }
  }
  return null;
};

const buildDailySummaryPayload = async (userId, dateStr, targetContextOverride = null) => {
  const targetContext = targetContextOverride || (await getDailyCalorieTargetContext({ db, userId, dateStr }));
  const targetCalories = Math.max(MIN_DAILY_CALORIES, Math.round(toNumber(targetContext.dailyCalories) || DEFAULT_DAILY_CALORIES));

  const macroGoal = targetContext.demographics?.goal || "maintain";
  const macroActivityLevel = targetContext.demographics?.activityLevel || "moderately_active";
  const macroTargets = calculateMacronutrientTargets({
    calorieTarget: targetCalories,
    goal: macroGoal,
    activityLevel: macroActivityLevel,
  });

  const target = {
    ...(targetContext.goalRecord || {}),
    dailyCalories: targetCalories,
    source: targetContext.source,
  };

  const meals = await db
    .select()
    .from(mealLogsTable)
    .where(and(eq(mealLogsTable.userId, userId), eq(mealLogsTable.date, dateStr)));

  let totalCalories = 0;
  let totalProtein = 0;
  let totalCarbs = 0;
  let totalFats = 0;

  meals.forEach((meal) => {
    totalCalories += toNumber(meal.calories);
    totalProtein += toNumber(meal.protein);
    totalCarbs += toNumber(meal.carbs);
    totalFats += toNumber(meal.fats);
  });

  const roundedConsumedCalories = Math.round(totalCalories);
  const remaining = Math.max(0, Math.round(targetCalories - totalCalories));
  const exhausted = Math.max(0, Math.round(totalCalories - targetCalories));
  const isOverTarget = totalCalories > targetCalories;

  return {
    goal: target,
    target: {
      dailyCalories: targetCalories,
      protein: macroTargets.grams.protein,
      carbs: macroTargets.grams.carbs,
      fats: macroTargets.grams.fats,
      ratios: macroTargets.ratios,
      source: targetContext.source,
    },
    consumed: {
      calories: roundedConsumedCalories,
      protein: Math.round(totalProtein),
      carbs: Math.round(totalCarbs),
      fats: Math.round(totalFats),
    },
    remaining,
    exhausted,
    isOverTarget,
  };
};

const getWeekBounds = (dateStr) => {
  const refDate = new Date(`${dateStr}T00:00:00`);
  const dayOfWeek = refDate.getDay();
  const diffToMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const monday = new Date(refDate);
  monday.setDate(refDate.getDate() - diffToMon);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  return {
    monday,
    startStr: getLocalYYYYMMDD(monday),
    endStr: getLocalYYYYMMDD(sunday),
  };
};

const buildWeeklyPayload = async (userId, dateStr) => {
  const { monday, startStr, endStr } = getWeekBounds(dateStr);

  const meals = await db
    .select()
    .from(mealLogsTable)
    .where(and(eq(mealLogsTable.userId, userId), gte(mealLogsTable.date, startStr), lte(mealLogsTable.date, endStr)));

  const weeklyData = {};
  const current = new Date(monday);

  for (let i = 0; i < 7; i++) {
    const dStr = getLocalYYYYMMDD(current);
    weeklyData[dStr] = {
      day: current.toLocaleDateString("en-US", { weekday: "short" }),
      date: dStr,
      calories: 0,
    };
    current.setDate(current.getDate() + 1);
  }

  meals.forEach((meal) => {
    const dateKey = normalizeMealDateKey(meal.date);
    if (dateKey && weeklyData[dateKey]) {
      weeklyData[dateKey].calories += toNumber(meal.calories);
    }
  });

  return Object.values(weeklyData);
};

const parseInsightsWindow = (value) => {
  const requestedWindow = Number.parseInt(String(value || "28"), 10);
  return Math.min(84, Math.max(7, Number.isFinite(requestedWindow) ? requestedWindow : 28));
};

const buildInsightsPayload = async (userId, dateStr, requestedWindow = 28, options = {}) => {
  const windowDays = parseInsightsWindow(requestedWindow);
  const referenceDate = new Date(`${dateStr}T00:00:00`);
  const startDate = new Date(referenceDate);
  startDate.setDate(referenceDate.getDate() - (windowDays - 1));
  const startStr = getLocalYYYYMMDD(startDate);
  const hasDemographicsOverride = Object.prototype.hasOwnProperty.call(options, "demographicsOverride");

  const [demographics, goals, meals] = await Promise.all([
    hasDemographicsOverride
      ? Promise.resolve(options.demographicsOverride ? [options.demographicsOverride] : [])
      : db.select().from(demographicsTable).where(eq(demographicsTable.userId, userId)).limit(1),
    db
      .select()
      .from(calorieGoalsTable)
      .where(
        and(
          eq(calorieGoalsTable.userId, userId),
          lte(calorieGoalsTable.startDate, dateStr),
          gte(calorieGoalsTable.endDate, startStr)
        )
      )
      .orderBy(desc(calorieGoalsTable.createdAt)),
    db
      .select()
      .from(mealLogsTable)
      .where(and(eq(mealLogsTable.userId, userId), gte(mealLogsTable.date, startStr), lte(mealLogsTable.date, dateStr))),
  ]);

  return buildCalorieInsights({
    referenceDate: dateStr,
    windowDays,
    meals,
    demographics: demographics[0] || null,
    goals,
  });
};

// 1. CREATE NEW GOAL
calorieRoutes.post("/create", requireClerkAuth, ensureClerkIdMatch("body"), attachUserFromAuth, async (req, res) => {
  try {
    const { goalName, dailyCalories, description, startDate, endDate, notificationsEnabled } = req.body;
    const startDateStr = normalizeDateString(startDate);
    const endDateStr = normalizeDateString(endDate);

    if (!startDateStr || !endDateStr) {
      return res.status(400).json({ error: "Invalid goal date format. Use YYYY-MM-DD" });
    }
    if (endDateStr < startDateStr) {
      return res.status(400).json({ error: "End date must be on or after start date" });
    }

    const userId = req.dbUser.userId;

    await db.insert(calorieGoalsTable).values({
      userId,
      goalName,
      dailyCalories: parseInt(dailyCalories),
      description,
      startDate: startDateStr,
      endDate: endDateStr,
      notificationsEnabled,
    });

    res.status(201).json({ success: true, message: "Goal created successfully" });
  } catch (error) {
    console.error("Create Goal Error:", error);
    res.status(500).json({ error: "Failed to create goal" });
  }
});

// 2. GET ALL GOALS FOR USER
calorieRoutes.get("/list/:clerkId", requireClerkAuth, ensureClerkIdMatch("params"), attachUserFromAuth, async (req, res) => {
  try {
    const userId = req.dbUser.userId;

    const goals = await db.select().from(calorieGoalsTable).where(eq(calorieGoalsTable.userId, userId));

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const goalsWithStatus = goals.map((goal) => {
      const endDate = new Date(goal.endDate);
      endDate.setHours(0, 0, 0, 0);

      return {
        ...goal,
        status: today > endDate ? "done" : "in-progress",
      };
    });

    res.json(goalsWithStatus);
  } catch (error) {
    console.error("Error fetching goals:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// 3. GET SINGLE GOAL (For Editing)
calorieRoutes.get("/detail/:id", requireClerkAuth, attachUserFromAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const goal = await db
      .select()
      .from(calorieGoalsTable)
      .where(and(eq(calorieGoalsTable.id, id), eq(calorieGoalsTable.userId, req.dbUser.userId)));
    if (goal.length === 0) return res.status(404).json({ error: "Goal not found" });
    res.json(goal[0]);
  } catch (error) {
    console.error("Fetch Goal Detail Error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// 4. UPDATE GOAL
calorieRoutes.put("/update/:id", requireClerkAuth, attachUserFromAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { goalName, dailyCalories, description, startDate, endDate, notificationsEnabled } = req.body;
    const startDateStr = normalizeDateString(startDate);
    const endDateStr = normalizeDateString(endDate);

    if (!startDateStr || !endDateStr) {
      return res.status(400).json({ error: "Invalid goal date format. Use YYYY-MM-DD" });
    }
    if (endDateStr < startDateStr) {
      return res.status(400).json({ error: "End date must be on or after start date" });
    }

    const updated = await db
      .update(calorieGoalsTable)
      .set({
        goalName,
        dailyCalories: parseInt(dailyCalories),
        description,
        startDate: startDateStr,
        endDate: endDateStr,
        notificationsEnabled,
        updatedAt: new Date(),
      })
      .where(and(eq(calorieGoalsTable.id, id), eq(calorieGoalsTable.userId, req.dbUser.userId)))
      .returning();

    if (updated.length === 0) {
      return res.status(404).json({ error: "Goal not found" });
    }

    res.json({ success: true, message: "Goal updated successfully" });
  } catch (error) {
    console.error("Update Goal Error:", error);
    res.status(500).json({ error: "Failed to update goal" });
  }
});

// 5. DELETE GOAL
calorieRoutes.delete("/delete/:id", requireClerkAuth, attachUserFromAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await db
      .delete(calorieGoalsTable)
      .where(and(eq(calorieGoalsTable.id, id), eq(calorieGoalsTable.userId, req.dbUser.userId)))
      .returning();
    if (deleted.length === 0) {
      return res.status(404).json({ error: "Goal not found" });
    }
    res.json({ success: true, message: "Goal deleted" });
  } catch (error) {
    console.error("Delete Goal Error:", error);
    res.status(500).json({ error: "Failed to delete goal" });
  }
});

// 6. GET DAILY SUMMARY (Goal vs Actual)
calorieRoutes.get("/summary/:clerkId/:date", requireClerkAuth, ensureClerkIdMatch("params"), attachUserFromAuth, async (req, res) => {
  try {
    const { date } = req.params;
    const dateStr = normalizeDateString(date);
    if (!dateStr) return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });

    const userId = req.dbUser.userId;

    res.json(await buildDailySummaryPayload(userId, dateStr));
  } catch (error) {
    console.error("Summary Error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

calorieRoutes.get("/dashboard/:clerkId/:date", requireClerkAuth, ensureClerkIdMatch("params"), attachUserFromAuth, async (req, res) => {
  try {
    const { date } = req.params;
    const dateStr = normalizeDateString(date);
    if (!dateStr) return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });

    const userId = req.dbUser.userId;

    const targetContextPromise = getDailyCalorieTargetContext({ db, userId, dateStr });
    const weeklyPromise = buildWeeklyPayload(userId, dateStr);
    const targetContext = await targetContextPromise;

    const [summary, weekly, insights] = await Promise.all([
      buildDailySummaryPayload(userId, dateStr, targetContext),
      weeklyPromise,
      buildInsightsPayload(userId, dateStr, req.query.window, {
        demographicsOverride: targetContext.demographics || null,
      }),
    ]);

    res.json({ summary, weekly, insights });
  } catch (error) {
    console.error("Dashboard Summary Error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// 7. GET WEEKLY CALORIE HISTORY
calorieRoutes.get("/weekly/:clerkId/:date", requireClerkAuth, ensureClerkIdMatch("params"), attachUserFromAuth, async (req, res) => {
  try {
    const { date } = req.params;
    const dateStr = normalizeDateString(date);
    if (!dateStr) return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });

    const userId = req.dbUser.userId;

    res.json(await buildWeeklyPayload(userId, dateStr));
  } catch (error) {
    console.error("Weekly Error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

calorieRoutes.get("/insights/:clerkId/:date", requireClerkAuth, ensureClerkIdMatch("params"), attachUserFromAuth, async (req, res) => {
  try {
    const { date } = req.params;
    const dateStr = normalizeDateString(date);
    if (!dateStr) return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });

    const requestedWindow = Number.parseInt(String(req.query.window || "28"), 10);
    const windowDays = Math.min(84, Math.max(7, Number.isFinite(requestedWindow) ? requestedWindow : 28));

    const userId = req.dbUser.userId;

    res.json(await buildInsightsPayload(userId, dateStr, windowDays));
  } catch (error) {
    console.error("Calorie Insights Error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

export default calorieRoutes;
