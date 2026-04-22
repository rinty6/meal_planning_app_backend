// This route handles calorie goal management, daily summaries, and weekly history.

import express from "express";
import { db } from "../config/db.js";
import { calorieGoalsTable, usersTable, mealLogsTable, demographicsTable } from "../db/schema.js";
import { and, lte, gte, desc, eq } from "drizzle-orm";
import { buildCalorieInsights } from "../services/calorieInsights.js";

const calorieRoutes = express.Router();
const DEFAULT_DAILY_CALORIES = 2000;
const MIN_DAILY_CALORIES = 1200;

const ACTIVITY_MULTIPLIERS = {
  lightly_active: 1.375,
  moderately_active: 1.55,
  very_active: 1.725,
  super_active: 1.9,
};

const normalizeDateString = (rawDate) => {
  if (typeof rawDate !== "string") return null;
  const dateStr = rawDate.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : null;
};

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toKilograms = (weight, unit) => {
  const parsedWeight = toNumber(weight);
  if (!parsedWeight) return 0;
  return unit === "lbs" ? parsedWeight * 0.45359237 : parsedWeight;
};

const toCentimeters = (height, unit) => {
  const parsedHeight = toNumber(height);
  if (!parsedHeight) return 0;
  return unit === "ft" ? parsedHeight * 30.48 : parsedHeight;
};

const getAgeFromDateOfBirth = (dateOfBirth) => {
  if (!dateOfBirth) return 0;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return 0;

  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
    age -= 1;
  }
  return Math.max(0, age);
};

const calculateBmr = ({ weightKg, heightCm, age, gender }) => {
  if (!weightKg || !heightCm || !age) return 0;

  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  if (gender === "male") return base + 5;
  if (gender === "female") return base - 161;
  return base - 78; // Neutral midpoint between male and female constants.
};

const estimateDailyCaloriesFromDemographics = (demographics) => {
  if (!demographics) return 0;

  const weightKg = toKilograms(demographics.weight, demographics.preferredWeightUnit);
  const heightCm = toCentimeters(demographics.height, demographics.preferredHeightUnit);
  const age = getAgeFromDateOfBirth(demographics.dateOfBirth);
  const bmr = calculateBmr({ weightKg, heightCm, age, gender: demographics.gender });
  if (!bmr) return 0;

  const activityMultiplier = ACTIVITY_MULTIPLIERS[demographics.activityLevel] || ACTIVITY_MULTIPLIERS.moderately_active;
  let dailyTarget = bmr * activityMultiplier;

  if (demographics.goal === "lose_weight") dailyTarget -= 500;
  if (demographics.goal === "gain_muscle") dailyTarget += 300;

  return Math.max(MIN_DAILY_CALORIES, Math.round(dailyTarget));
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

const getDailyCalorieTargetContext = async (userId, dateStr) => {
  const demographics = await db
    .select()
    .from(demographicsTable)
    .where(eq(demographicsTable.userId, userId))
    .limit(1);

  const profile = demographics.length > 0 ? demographics[0] : null;

  const activeGoals = await db
    .select()
    .from(calorieGoalsTable)
    .where(and(eq(calorieGoalsTable.userId, userId), lte(calorieGoalsTable.startDate, dateStr), gte(calorieGoalsTable.endDate, dateStr)))
    .orderBy(desc(calorieGoalsTable.createdAt))
    .limit(1);

  if (activeGoals.length > 0) {
    const activeGoal = activeGoals[0];
    return {
      source: "goal",
      goalRecord: activeGoal,
      dailyCalories: Math.max(MIN_DAILY_CALORIES, Math.round(toNumber(activeGoal.dailyCalories) || DEFAULT_DAILY_CALORIES)),
      demographics: profile,
    };
  }
  const estimatedCalories = estimateDailyCaloriesFromDemographics(profile);

  if (estimatedCalories > 0) {
    return {
      source: "bmr",
      goalRecord: {
        id: "bmr-estimated",
        goalName: "Estimated Daily Target (BMR)",
        description: "Auto-calculated from profile demographics",
        dailyCalories: estimatedCalories,
      },
      dailyCalories: estimatedCalories,
      demographics: profile,
    };
  }

  return {
    source: "default",
    goalRecord: {
      id: "default",
      goalName: "Daily Target (Default)",
      description: "Fallback default target",
      dailyCalories: DEFAULT_DAILY_CALORIES,
    },
    dailyCalories: DEFAULT_DAILY_CALORIES,
    demographics: profile,
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

// 1. CREATE NEW GOAL
calorieRoutes.post("/create", async (req, res) => {
  try {
    const { clerkId, goalName, dailyCalories, description, startDate, endDate, notificationsEnabled } = req.body;

    const user = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId)).limit(1);
    if (user.length === 0) return res.status(404).json({ error: "User not found" });
    const userId = user[0].userId;

    await db.insert(calorieGoalsTable).values({
      userId,
      goalName,
      dailyCalories: parseInt(dailyCalories),
      description,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      notificationsEnabled,
    });

    res.status(201).json({ success: true, message: "Goal created successfully" });
  } catch (error) {
    console.error("Create Goal Error:", error);
    res.status(500).json({ error: "Failed to create goal" });
  }
});

// 2. GET ALL GOALS FOR USER
calorieRoutes.get("/list/:clerkId", async (req, res) => {
  try {
    const { clerkId } = req.params;
    const user = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId)).limit(1);

    if (user.length === 0) return res.status(404).json({ error: "User not found" });
    const userId = user[0].userId;

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
calorieRoutes.get("/detail/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const goal = await db.select().from(calorieGoalsTable).where(eq(calorieGoalsTable.id, id));
    if (goal.length === 0) return res.status(404).json({ error: "Goal not found" });
    res.json(goal[0]);
  } catch (error) {
    console.error("Fetch Goal Detail Error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// 4. UPDATE GOAL
calorieRoutes.put("/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { goalName, dailyCalories, description, startDate, endDate, notificationsEnabled } = req.body;

    await db
      .update(calorieGoalsTable)
      .set({
        goalName,
        dailyCalories: parseInt(dailyCalories),
        description,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        notificationsEnabled,
        updatedAt: new Date(),
      })
      .where(eq(calorieGoalsTable.id, id));

    res.json({ success: true, message: "Goal updated successfully" });
  } catch (error) {
    console.error("Update Goal Error:", error);
    res.status(500).json({ error: "Failed to update goal" });
  }
});

// 5. DELETE GOAL
calorieRoutes.delete("/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.delete(calorieGoalsTable).where(eq(calorieGoalsTable.id, id));
    res.json({ success: true, message: "Goal deleted" });
  } catch (error) {
    console.error("Delete Goal Error:", error);
    res.status(500).json({ error: "Failed to delete goal" });
  }
});

// 6. GET DAILY SUMMARY (Goal vs Actual)
calorieRoutes.get("/summary/:clerkId/:date", async (req, res) => {
  try {
    const { clerkId, date } = req.params;
    const dateStr = normalizeDateString(date);
    if (!dateStr) return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });

    // 1. Get user ID
    const user = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId)).limit(1);
    if (user.length === 0) return res.status(404).json({ error: "User not found" });
    const userId = user[0].userId;

    // 2. Resolve daily calorie target from active goal first, then BMR fallback.
    const targetContext = await getDailyCalorieTargetContext(userId, dateStr);
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

    // 3. Get meals for the requested date.
    const meals = await db
      .select()
      .from(mealLogsTable)
      .where(and(eq(mealLogsTable.userId, userId), eq(mealLogsTable.date, dateStr)));

    // 4. Calculate totals using numeric coercion to avoid string concatenation bugs.
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

    // 5. Return data
    res.json({
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
    });
  } catch (error) {
    console.error("Summary Error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// 7. GET WEEKLY CALORIE HISTORY
calorieRoutes.get("/weekly/:clerkId/:date", async (req, res) => {
  try {
    const { clerkId, date } = req.params;
    const dateStr = normalizeDateString(date);
    if (!dateStr) return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });

    // 1. Get user
    const user = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId)).limit(1);
    if (user.length === 0) return res.status(404).json({ error: "User not found" });
    const userId = user[0].userId;

    // 2. Calculate week range (Mon -> Sun) in local time.
    const refDate = new Date(`${dateStr}T00:00:00`);
    const dayOfWeek = refDate.getDay();
    const diffToMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

    const monday = new Date(refDate);
    monday.setDate(refDate.getDate() - diffToMon);

    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    const startStr = getLocalYYYYMMDD(monday);
    const endStr = getLocalYYYYMMDD(sunday);

    // 3. Query meals in the week range.
    const meals = await db
      .select()
      .from(mealLogsTable)
      .where(and(eq(mealLogsTable.userId, userId), gte(mealLogsTable.date, startStr), lte(mealLogsTable.date, endStr)));

    // 4. Build 7-day response scaffold.
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

    // 5. Populate scaffold.
    meals.forEach((meal) => {
      const dateKey = normalizeMealDateKey(meal.date);
      if (dateKey && weeklyData[dateKey]) {
        weeklyData[dateKey].calories += toNumber(meal.calories);
      }
    });

    res.json(Object.values(weeklyData));
  } catch (error) {
    console.error("Weekly Error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

calorieRoutes.get("/insights/:clerkId/:date", async (req, res) => {
  try {
    const { clerkId, date } = req.params;
    const dateStr = normalizeDateString(date);
    if (!dateStr) return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });

    const requestedWindow = Number.parseInt(String(req.query.window || "28"), 10);
    const windowDays = Math.min(84, Math.max(7, Number.isFinite(requestedWindow) ? requestedWindow : 28));

    const user = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId)).limit(1);
    if (user.length === 0) return res.status(404).json({ error: "User not found" });
    const userId = user[0].userId;

    const referenceDate = new Date(`${dateStr}T00:00:00`);
    const startDate = new Date(referenceDate);
    startDate.setDate(referenceDate.getDate() - (windowDays - 1));
    const startStr = getLocalYYYYMMDD(startDate);

    const [demographics, goals, meals] = await Promise.all([
      db.select().from(demographicsTable).where(eq(demographicsTable.userId, userId)).limit(1),
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

    const insights = buildCalorieInsights({
      referenceDate: dateStr,
      windowDays,
      meals,
      demographics: demographics[0] || null,
      goals,
    });

    res.json(insights);
  } catch (error) {
    console.error("Calorie Insights Error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

export default calorieRoutes;
