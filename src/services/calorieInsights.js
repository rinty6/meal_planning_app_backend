const DEFAULT_DAILY_CALORIES = 2000;
const MIN_DAILY_CALORIES = 1200;
const WEEKDAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MEAL_TYPE_ORDER = ["breakfast", "lunch", "dinner"];

const ACTIVITY_MULTIPLIERS = {
  lightly_active: 1.375,
  moderately_active: 1.55,
  very_active: 1.725,
  super_active: 1.9,
};

const FOOD_TAG_RULES = [
  {
    tag: "sugary_drink",
    keywords: [
      "coke",
      "cola",
      "soda",
      "soft drink",
      "pepsi",
      "sprite",
      "fanta",
      "energy drink",
      "sports drink",
      "gatorade",
      "powerade",
      "red bull",
      "sweet tea",
      "milk tea",
      "bubble tea",
      "boba",
      "frappuccino",
    ],
  },
  {
    tag: "dessert_snack",
    keywords: [
      "cake",
      "cookie",
      "brownie",
      "ice cream",
      "donut",
      "doughnut",
      "muffin",
      "candy",
      "chocolate",
      "dessert",
      "chips",
      "crisps",
    ],
  },
  {
    tag: "processed_food",
    keywords: [
      "burger",
      "pizza",
      "sausage",
      "bacon",
      "nugget",
      "fried chicken",
      "hot dog",
      "pepperoni",
      "salami",
      "fries",
      "instant noodle",
      "ramen",
    ],
  },
  {
    tag: "fruit_vegetable",
    keywords: [
      "apple",
      "banana",
      "berries",
      "berry",
      "orange",
      "pear",
      "grape",
      "mango",
      "pineapple",
      "avocado",
      "salad",
      "broccoli",
      "spinach",
      "kale",
      "carrot",
      "tomato",
      "cucumber",
      "vegetable",
    ],
  },
  {
    tag: "lean_protein",
    keywords: [
      "chicken breast",
      "grilled chicken",
      "salmon",
      "tuna",
      "tofu",
      "egg",
      "eggs",
      "greek yogurt",
      "turkey",
      "lentil",
      "lentils",
      "bean",
      "beans",
    ],
  },
];

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

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
  return base - 78;
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

const getLocalYYYYMMDD = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const normalizeDateKey = (value) => {
  if (!value) return "";
  if (value instanceof Date) return getLocalYYYYMMDD(value);

  const cleaned = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;

  const parsed = new Date(cleaned);
  if (!Number.isNaN(parsed.getTime())) return getLocalYYYYMMDD(parsed);
  return cleaned;
};

const parseDateKey = (dateKey) => new Date(`${dateKey}T00:00:00`);

const getDateWindow = (referenceDate, windowDays) => {
  const safeWindowDays = clamp(Math.round(toNumber(windowDays) || 28), 7, 84);
  const endDate = parseDateKey(referenceDate);
  const startDate = new Date(endDate);
  startDate.setDate(endDate.getDate() - (safeWindowDays - 1));

  const dateKeys = [];
  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    dateKeys.push(getLocalYYYYMMDD(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return {
    safeWindowDays,
    startDate: getLocalYYYYMMDD(startDate),
    endDate: getLocalYYYYMMDD(endDate),
    dateKeys,
  };
};

const normalizeText = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const buildConfidence = ({ loggedDays, mealCount, classifiedMeals = 0, requireClassification = false }) => {
  const classificationRate = mealCount > 0 ? classifiedMeals / mealCount : 0;

  if (requireClassification) {
    if (loggedDays >= 14 && mealCount >= 20 && classificationRate >= 0.45) return "high";
    if (loggedDays >= 7 && mealCount >= 10 && classificationRate >= 0.25) return "medium";
    return "low";
  }

  if (loggedDays >= 14 && mealCount >= 20) return "high";
  if (loggedDays >= 7 && mealCount >= 8) return "medium";
  return "low";
};

const classifyFoodTags = (foodName) => {
  const normalized = normalizeText(foodName);
  const matchedTags = new Set();

  for (const rule of FOOD_TAG_RULES) {
    if (rule.keywords.some((keyword) => normalized.includes(keyword))) {
      matchedTags.add(rule.tag);
    }
  }

  return Array.from(matchedTags);
};

const createWeekdayScaffold = () =>
  WEEKDAY_ORDER.reduce((accumulator, day) => {
    accumulator[day] = { day, totalCalories: 0, loggedCount: 0, averageCalories: 0 };
    return accumulator;
  }, {});

const createMealSlotScaffold = () =>
  MEAL_TYPE_ORDER.reduce((accumulator, mealType) => {
    accumulator[mealType] = { mealType, totalCalories: 0, loggedCount: 0, averageCalories: 0 };
    return accumulator;
  }, {});

const resolveTargetForDate = ({ dateKey, goals, demographics }) => {
  const matchingGoal = goals.find((goal) => {
    const startDate = normalizeDateKey(goal?.startDate);
    const endDate = normalizeDateKey(goal?.endDate);
    return startDate <= dateKey && endDate >= dateKey;
  });

  if (matchingGoal) {
    return {
      source: "goal",
      dailyCalories: Math.max(MIN_DAILY_CALORIES, Math.round(toNumber(matchingGoal.dailyCalories) || DEFAULT_DAILY_CALORIES)),
    };
  }

  const estimatedCalories = estimateDailyCaloriesFromDemographics(demographics);
  if (estimatedCalories > 0) {
    return {
      source: "bmr",
      dailyCalories: estimatedCalories,
    };
  }

  return {
    source: "default",
    dailyCalories: DEFAULT_DAILY_CALORIES,
  };
};

const buildDailyBreakdown = ({ dateKeys, meals, goals, demographics }) => {
  const mealsByDate = new Map();

  for (const meal of meals) {
    const dateKey = normalizeDateKey(meal?.date);
    if (!mealsByDate.has(dateKey)) {
      mealsByDate.set(dateKey, []);
    }
    mealsByDate.get(dateKey).push(meal);
  }

  return dateKeys.map((dateKey) => {
    const mealsForDay = mealsByDate.get(dateKey) || [];
    const consumedCalories = mealsForDay.reduce((sum, meal) => sum + toNumber(meal?.calories), 0);
    const target = resolveTargetForDate({ dateKey, goals, demographics });
    const lowerBound = target.dailyCalories * 0.9;
    const upperBound = target.dailyCalories * 1.1;
    const hasLogs = mealsForDay.length > 0;

    return {
      date: dateKey,
      weekday: parseDateKey(dateKey).toLocaleDateString("en-US", { weekday: "short" }),
      mealCount: mealsForDay.length,
      consumedCalories: Math.round(consumedCalories),
      targetCalories: target.dailyCalories,
      targetSource: target.source,
      hasLogs,
      isOnTarget: hasLogs && consumedCalories >= lowerBound && consumedCalories <= upperBound,
      isOverTarget: hasLogs && consumedCalories > upperBound,
      isUnderTarget: hasLogs && consumedCalories < lowerBound,
    };
  });
};

const buildAdherenceInsight = ({ dailyBreakdown, windowDays, mealCount }) => {
  const loggedDays = dailyBreakdown.filter((day) => day.hasLogs);
  const calendarDays = dailyBreakdown.length;
  const daysOnTarget = loggedDays.filter((day) => day.isOnTarget).length;
  const daysOverTarget = loggedDays.filter((day) => day.isOverTarget).length;
  const daysUnderTarget = loggedDays.filter((day) => day.isUnderTarget).length;
  const adherenceRate = loggedDays.length > 0 ? daysOnTarget / loggedDays.length : 0;
  const confidence = buildConfidence({ loggedDays: loggedDays.length, mealCount });

  if (loggedDays.length === 0) {
    return {
      confidence: "low",
      loggedDays: 0,
      calendarDays,
      daysOnTarget: 0,
      daysOverTarget: 0,
      daysUnderTarget: 0,
      adherenceRate: 0,
      trend: "neutral",
      summary: `Log a few meals during the next ${windowDays} days to unlock calorie-target insights.`,
      detail: "We need real meal history before we can compare your intake against your target.",
    };
  }

  const trend = adherenceRate >= 0.6 ? "positive" : daysOverTarget > daysUnderTarget ? "attention" : "neutral";
  const detail =
    daysOverTarget > daysUnderTarget
      ? "Your higher-calorie days are appearing more often than your lower-calorie days."
      : daysUnderTarget > daysOverTarget
        ? "You trend under your target more often than above it."
        : "Your calories are moving around the target without a strong over-or-under trend.";

  return {
    confidence,
    loggedDays: loggedDays.length,
    calendarDays,
    daysOnTarget,
    daysOverTarget,
    daysUnderTarget,
    adherenceRate: Math.round(adherenceRate * 100) / 100,
    trend,
    summary: `You landed within 10% of your calorie target on ${daysOnTarget} of ${loggedDays.length} logged days.`,
    detail,
  };
};

const buildWeekdayInsight = ({ dailyBreakdown, mealCount }) => {
  const weekdayStats = createWeekdayScaffold();
  const loggedDays = dailyBreakdown.filter((day) => day.hasLogs);

  for (const day of loggedDays) {
    const weekday = weekdayStats[day.weekday];
    if (!weekday) continue;
    weekday.totalCalories += toNumber(day.consumedCalories);
    weekday.loggedCount += 1;
    weekday.averageCalories = Math.round(weekday.totalCalories / weekday.loggedCount);
  }

  const averages = WEEKDAY_ORDER.map((day) => weekdayStats[day]);
  const populated = averages.filter((entry) => entry.loggedCount > 0);
  const confidence = buildConfidence({ loggedDays: loggedDays.length, mealCount });

  if (populated.length === 0) {
    return {
      confidence: "low",
      topWeekday: null,
      lowestWeekday: null,
      averages,
      trend: "neutral",
      summary: "Weekday calorie trends will appear once you log meals across more days.",
      detail: "We compare weekday averages so one busy day does not dominate the pattern.",
    };
  }

  const topWeekday = [...populated].sort((left, right) => right.averageCalories - left.averageCalories)[0];
  const lowestWeekday = [...populated].sort((left, right) => left.averageCalories - right.averageCalories)[0];

  return {
    confidence,
    topWeekday,
    lowestWeekday,
    averages,
    trend: topWeekday.averageCalories >= lowestWeekday.averageCalories * 1.2 ? "attention" : "neutral",
    summary: `${topWeekday.day} is your highest-calorie day on average at about ${topWeekday.averageCalories} kcal.`,
    detail: `This is based on weekday averages, not raw totals, across ${loggedDays.length} logged days.`,
  };
};

const buildMealPatternInsight = ({ meals, mealCount, loggedDays }) => {
  const slotDayTotals = new Map();

  for (const meal of meals) {
    const mealType = normalizeText(meal?.mealType);
    if (!MEAL_TYPE_ORDER.includes(mealType)) continue;
    const dateKey = normalizeDateKey(meal?.date);
    const key = `${dateKey}:${mealType}`;
    slotDayTotals.set(key, (slotDayTotals.get(key) || 0) + toNumber(meal?.calories));
  }

  const mealSlots = createMealSlotScaffold();

  for (const [key, calories] of slotDayTotals.entries()) {
    const mealType = key.split(":")[1];
    const slot = mealSlots[mealType];
    if (!slot) continue;
    slot.totalCalories += calories;
    slot.loggedCount += 1;
    slot.averageCalories = Math.round(slot.totalCalories / slot.loggedCount);
  }

  const averages = MEAL_TYPE_ORDER.map((mealType) => mealSlots[mealType]);
  const populated = averages.filter((slot) => slot.loggedCount > 0);
  const confidence = buildConfidence({ loggedDays, mealCount });

  if (populated.length === 0) {
    return {
      confidence: "low",
      peakMealType: null,
      averages,
      trend: "neutral",
      summary: "Meal-slot trends will appear once you log breakfast, lunch, or dinner more consistently.",
      detail: "This phase uses breakfast, lunch, and dinner averages instead of clock times.",
    };
  }

  const peakMealType = [...populated].sort((left, right) => right.averageCalories - left.averageCalories)[0];
  const mealTypeLabel = peakMealType.mealType.charAt(0).toUpperCase() + peakMealType.mealType.slice(1);

  return {
    confidence,
    peakMealType,
    averages,
    trend: peakMealType.averageCalories >= 700 ? "attention" : "neutral",
    summary: `${mealTypeLabel} is your largest meal slot on average at about ${peakMealType.averageCalories} kcal.`,
    detail: "We compare total calories per meal slot per day rather than relying on log timestamps.",
  };
};

const buildFoodPatternInsight = ({ meals, loggedDays }) => {
  const topFoodMap = new Map();
  const tagCounts = new Map();
  let classifiedMeals = 0;

  for (const meal of meals) {
    const displayName = String(meal?.foodName || "Unknown food").trim() || "Unknown food";
    const normalizedName = normalizeText(displayName);
    if (!topFoodMap.has(normalizedName)) {
      topFoodMap.set(normalizedName, {
        name: displayName,
        count: 0,
        totalCalories: 0,
      });
    }

    const foodEntry = topFoodMap.get(normalizedName);
    foodEntry.count += 1;
    foodEntry.totalCalories += toNumber(meal?.calories);

    const tags = classifyFoodTags(displayName);
    if (tags.length > 0) {
      classifiedMeals += 1;
    }

    for (const tag of tags) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }

  const mealCount = meals.length;
  const topFoods = Array.from(topFoodMap.values())
    .map((entry) => ({
      name: entry.name,
      count: entry.count,
      averageCalories: entry.count > 0 ? Math.round(entry.totalCalories / entry.count) : 0,
    }))
    .sort((left, right) => right.count - left.count || right.averageCalories - left.averageCalories)
    .slice(0, 3);

  const confidence = buildConfidence({
    loggedDays,
    mealCount,
    classifiedMeals,
    requireClassification: true,
  });

  if (mealCount === 0) {
    return {
      confidence: "low",
      topFoods: [],
      signals: [],
      summary: "Food-pattern insights need a few logged meals before they can say anything useful.",
      detail: "We only surface health-pattern signals when there is enough evidence in the food log.",
      classificationRate: 0,
      classifiedMeals: 0,
    };
  }

  const shareFor = (tag) => (mealCount > 0 ? (tagCounts.get(tag) || 0) / mealCount : 0);
  const signals = [];

  if ((tagCounts.get("sugary_drink") || 0) >= 3 && shareFor("sugary_drink") >= 0.12) {
    signals.push({
      id: "sugary_drink",
      tone: "attention",
      title: "Sugary drinks show up often",
      summary: "Sweetened drinks are appearing regularly in your recent log.",
      reason: "Liquid calories can make long-term calorie control harder because they add energy without much fullness.",
    });
  }

  if ((tagCounts.get("processed_food") || 0) >= 4 && shareFor("processed_food") >= 0.18) {
    signals.push({
      id: "processed_food",
      tone: "attention",
      title: "Processed convenience foods are common",
      summary: "Highly processed meals appear frequently in your recent history.",
      reason: "A steady pattern of fast-food or heavily processed choices can make it harder to keep diet quality consistent over time.",
    });
  }

  if ((tagCounts.get("dessert_snack") || 0) >= 4 && shareFor("dessert_snack") >= 0.18) {
    signals.push({
      id: "dessert_snack",
      tone: "attention",
      title: "Dessert and snack foods are a visible pattern",
      summary: "Sweet treats or snack foods appear often enough to stand out.",
      reason: "Frequent energy-dense snacks can quietly lift total calories without adding much nutritional balance.",
    });
  }

  if ((tagCounts.get("fruit_vegetable") || 0) >= 6 && shareFor("fruit_vegetable") >= 0.25) {
    signals.push({
      id: "fruit_vegetable",
      tone: "positive",
      title: "Fruit and vegetable choices are showing up",
      summary: "Produce appears regularly in your food log.",
      reason: "A repeated fruit and vegetable pattern usually supports better long-term diet quality and meal balance.",
    });
  }

  if ((tagCounts.get("lean_protein") || 0) >= 5 && shareFor("lean_protein") >= 0.2) {
    signals.push({
      id: "lean_protein",
      tone: "positive",
      title: "Lean protein looks consistent",
      summary: "Protein-focused foods are a recurring part of your meals.",
      reason: "Consistent protein choices can support fullness and make daily calorie targets easier to manage.",
    });
  }

  if (signals.length === 0) {
    signals.push({
      id: "no_strong_pattern",
      tone: confidence === "low" ? "neutral" : "positive",
      title: "No strong food pattern yet",
      summary:
        confidence === "low"
          ? "Your current meal history is still too light for strong food-quality conclusions."
          : "Your recent log looks mixed, without one food pattern dominating the others.",
      reason: "As you log more meals, the app can separate steady habits from one-off choices more reliably.",
    });
  }

  return {
    confidence,
    topFoods,
    signals: signals.slice(0, 3),
    summary: signals[0].summary,
    detail: signals[0].reason,
    classificationRate: mealCount > 0 ? Math.round((classifiedMeals / mealCount) * 100) / 100 : 0,
    classifiedMeals,
  };
};

export const buildCalorieInsights = ({
  referenceDate,
  windowDays = 28,
  meals = [],
  demographics = null,
  goals = [],
} = {}) => {
  const { safeWindowDays, startDate, endDate, dateKeys } = getDateWindow(referenceDate, windowDays);
  const boundedMeals = meals.filter((meal) => {
    const dateKey = normalizeDateKey(meal?.date);
    return dateKey >= startDate && dateKey <= endDate;
  });

  const dailyBreakdown = buildDailyBreakdown({
    dateKeys,
    meals: boundedMeals,
    goals,
    demographics,
  });

  const loggedDays = dailyBreakdown.filter((day) => day.hasLogs).length;
  const mealCount = boundedMeals.length;
  const adherence = buildAdherenceInsight({
    dailyBreakdown,
    windowDays: safeWindowDays,
    mealCount,
  });
  const weekdayPattern = buildWeekdayInsight({
    dailyBreakdown,
    mealCount,
  });
  const mealPattern = buildMealPatternInsight({
    meals: boundedMeals,
    mealCount,
    loggedDays,
  });
  const foodPattern = buildFoodPatternInsight({
    meals: boundedMeals,
    loggedDays,
  });

  const coverageConfidence = buildConfidence({
    loggedDays,
    mealCount,
    classifiedMeals: foodPattern.classifiedMeals,
    requireClassification: false,
  });

  return {
    windowDays: safeWindowDays,
    range: {
      startDate,
      endDate,
      referenceDate: endDate,
    },
    coverage: {
      calendarDays: dateKeys.length,
      loggedDays,
      mealCount,
      classifiedMeals: foodPattern.classifiedMeals,
      classificationRate: foodPattern.classificationRate,
      confidence: coverageConfidence,
      summary: `Based on ${loggedDays} logged days and ${mealCount} meals in the last ${safeWindowDays} days.`,
    },
    adherence,
    weekdayPattern,
    mealPattern,
    foodPattern,
    dailyBreakdown,
  };
};
