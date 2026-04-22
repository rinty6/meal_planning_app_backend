const ensureArray = (value) => {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
};

export const parseDescriptionMacros = (description = "") => {
  const text = String(description);
  const calories = Number.parseFloat(text.match(/Calories:\s*([\d.]+)/i)?.[1]) || 0;
  const protein = Number.parseFloat(text.match(/Protein:\s*([\d.]+)/i)?.[1]) || 0;
  const carbs = Number.parseFloat(text.match(/Carbs?:\s*([\d.]+)/i)?.[1]) || 0;
  const fats = Number.parseFloat(text.match(/Fat:\s*([\d.]+)/i)?.[1]) || 0;
  return { calories, protein, carbs, fats };
};

export const normalizePer100 = (serving) => {
  const metricServingAmount = Number.parseFloat(serving?.metric_serving_amount) || 0;
  const calories = Number.parseFloat(serving?.calories) || 0;
  const protein = Number.parseFloat(serving?.protein) || 0;
  const carbs = Number.parseFloat(serving?.carbohydrate) || 0;
  const fats = Number.parseFloat(serving?.fat) || 0;

  if (metricServingAmount > 0) {
    const factor = 100 / metricServingAmount;
    return {
      calories: calories * factor,
      protein: protein * factor,
      carbs: carbs * factor,
      fats: fats * factor,
    };
  }

  return { calories, protein, carbs, fats };
};

export const choosePrimaryServing = (food) => {
  const servings = ensureArray(food?.servings?.serving);
  return servings.find((serving) => Number.parseFloat(serving?.metric_serving_amount) > 0) || servings[0] || {};
};

export const parseAllergens = (food) =>
  ensureArray(food?.allergens?.allergen).map((allergen) => ({
    id: allergen?.id ?? null,
    name: allergen?.name ?? null,
    value: allergen?.value ?? null,
  }));

export const parsePreferences = (food) =>
  ensureArray(food?.preferences?.preference).map((preference) => ({
    id: preference?.id ?? null,
    name: preference?.name ?? null,
    value: preference?.value ?? null,
  }));

export const parseSubCategories = (food) =>
  ensureArray(food?.food_sub_categories?.food_sub_category)
    .map((entry) => (typeof entry === "string" ? entry : entry?.food_sub_category))
    .filter(Boolean);
