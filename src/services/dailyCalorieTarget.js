// Canonical daily-calorie policy shared by every backend feature that needs a target.
// Precedence is: newest goal active on the requested date -> onboarding BMR/TDEE
// estimate -> 2000 only when the profile cannot produce an estimate. Keeping the
// database lookup and pure calculation here prevents screens/routes from drifting.
import { and, desc, eq, gte, lte } from "drizzle-orm";

import { calorieGoalsTable, demographicsTable } from "../db/schema.js";

export const DEFAULT_DAILY_CALORIES = 2000;
export const MIN_DAILY_CALORIES = 1200;

const ACTIVITY_MULTIPLIERS = {
  lightly_active: 1.375,
  moderately_active: 1.55,
  very_active: 1.725,
  super_active: 1.9,
};

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const getLocalYYYYMMDD = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const normalizeCalorieTargetDate = (value) => {
  if (!value) return "";
  if (value instanceof Date) return getLocalYYYYMMDD(value);

  const cleaned = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;

  const parsed = new Date(cleaned);
  return Number.isNaN(parsed.getTime()) ? "" : getLocalYYYYMMDD(parsed);
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

const getAgeFromDateOfBirth = (dateOfBirth, today = new Date()) => {
  if (!dateOfBirth) return 0;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return 0;

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
  return base - 78;
};

export const estimateDailyCaloriesFromDemographics = (demographics, { today = new Date() } = {}) => {
  if (!demographics) return 0;

  const weightKg = toKilograms(demographics.weight, demographics.preferredWeightUnit);
  const heightCm = toCentimeters(demographics.height, demographics.preferredHeightUnit);
  const age = getAgeFromDateOfBirth(demographics.dateOfBirth, today);
  const bmr = calculateBmr({ weightKg, heightCm, age, gender: demographics.gender });
  if (!bmr) return 0;

  const activityMultiplier = ACTIVITY_MULTIPLIERS[demographics.activityLevel] || ACTIVITY_MULTIPLIERS.moderately_active;
  let dailyTarget = bmr * activityMultiplier;

  if (demographics.goal === "lose_weight") dailyTarget -= 500;
  if (demographics.goal === "gain_muscle") dailyTarget += 300;

  return Math.max(MIN_DAILY_CALORIES, Math.round(dailyTarget));
};

const goalRecency = (goal) => {
  const createdAt = new Date(goal?.createdAt || 0).getTime();
  if (Number.isFinite(createdAt) && createdAt > 0) return createdAt;
  return toNumber(goal?.id);
};

export const findActiveCalorieGoal = (goals, dateStr) => {
  const normalizedDate = normalizeCalorieTargetDate(dateStr);
  if (!normalizedDate || !Array.isArray(goals)) return null;

  return (
    goals
      .filter((goal) => {
        const startDate = normalizeCalorieTargetDate(goal?.startDate);
        const endDate = normalizeCalorieTargetDate(goal?.endDate);
        return startDate && endDate && startDate <= normalizedDate && endDate >= normalizedDate;
      })
      .sort((left, right) => goalRecency(right) - goalRecency(left))[0] || null
  );
};

export const resolveDailyCalorieTarget = ({
  dateStr,
  goals = [],
  demographics = null,
  today = new Date(),
}) => {
  const activeGoal = findActiveCalorieGoal(goals, dateStr);
  if (activeGoal) {
    return {
      source: "goal",
      goalRecord: activeGoal,
      dailyCalories: Math.max(
        MIN_DAILY_CALORIES,
        Math.round(toNumber(activeGoal.dailyCalories) || DEFAULT_DAILY_CALORIES)
      ),
      demographics,
    };
  }

  const estimatedCalories = estimateDailyCaloriesFromDemographics(demographics, { today });
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
      demographics,
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
    demographics,
  };
};

export const getDailyCalorieTargetContext = async ({ db, userId, dateStr }) => {
  // Accept the db instance from the caller so the policy stays testable without
  // opening a real database connection in unit tests.
  const normalizedDate = normalizeCalorieTargetDate(dateStr);
  if (!normalizedDate) {
    throw new Error("A valid YYYY-MM-DD date is required to resolve a calorie target.");
  }

  const [demographicsRows, activeGoals] = await Promise.all([
    db
      .select()
      .from(demographicsTable)
      .where(eq(demographicsTable.userId, userId))
      .limit(1),
    db
      .select()
      .from(calorieGoalsTable)
      .where(
        and(
          eq(calorieGoalsTable.userId, userId),
          lte(calorieGoalsTable.startDate, normalizedDate),
          gte(calorieGoalsTable.endDate, normalizedDate)
        )
      )
      .orderBy(desc(calorieGoalsTable.createdAt))
      .limit(1),
  ]);

  return resolveDailyCalorieTarget({
    dateStr: normalizedDate,
    goals: activeGoals,
    demographics: demographicsRows[0] || null,
  });
};
