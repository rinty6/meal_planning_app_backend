const ensureArray = (value) => {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
};

const derivePer100FromItem = (item) => {
  if (item?.per100) {
    return {
      calories: Number(item.per100.calories || 0),
      protein: Number(item.per100.protein || 0),
      carbs: Number(item.per100.carbs || 0),
      fats: Number(item.per100.fats || 0),
    };
  }

  const grams = Number(item?.grams || 100) || 100;
  const ratio = grams / 100 || 1;
  return {
    calories: Number(item?.calories || 0) / ratio,
    protein: Number(item?.protein || 0) / ratio,
    carbs: Number(item?.carbs || 0) / ratio,
    fats: Number(item?.fats || 0) / ratio,
  };
};

const scaleMacros = (per100, grams) => {
  const ratio = grams / 100;
  return {
    calories: Number(per100.calories || 0) * ratio,
    protein: Number(per100.protein || 0) * ratio,
    carbs: Number(per100.carbs || 0) * ratio,
    fats: Number(per100.fats || 0) * ratio,
  };
};

const computeTotals = (items = []) =>
  items.reduce(
    (agg, item) => ({
      calories: agg.calories + Number(item.calories || 0),
      protein: agg.protein + Number(item.protein || 0),
      carbs: agg.carbs + Number(item.carbs || 0),
      fats: agg.fats + Number(item.fats || 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fats: 0 }
  );

const normalizeTotals = (totals = {}) => ({
  calories: Math.round(Number(totals.calories || 0)),
  protein: Math.round(Number(totals.protein || 0) * 10) / 10,
  carbs: Math.round(Number(totals.carbs || 0) * 10) / 10,
  fats: Math.round(Number(totals.fats || 0) * 10) / 10,
});

const scaleSingleItem = (item, grams) => {
  const safeGrams = Math.max(20, Math.round(Number(grams) || 100));
  const macros = scaleMacros(item.per100, safeGrams);
  return {
    ...item,
    grams: safeGrams,
    calories: Math.round(macros.calories),
    protein: Math.round(macros.protein * 10) / 10,
    carbs: Math.round(macros.carbs * 10) / 10,
    fats: Math.round(macros.fats * 10) / 10,
  };
};

export const scaleComboToTarget = (items = [], slotTarget = 0) => {
  const normalizedItems = ensureArray(items).map((item) => ({
    ...item,
    grams: Number(item?.grams || 100) || 100,
    per100: derivePer100FromItem(item),
  }));

  if (normalizedItems.length === 0) {
    return { items: [], totals: { calories: 0, protein: 0, carbs: 0, fats: 0 }, scaleRatio: 1 };
  }

  const baseTotals = normalizedItems.reduce(
    (totals, item) => {
      const macros = scaleMacros(item.per100, item.grams);
      return {
        calories: totals.calories + macros.calories,
        protein: totals.protein + macros.protein,
        carbs: totals.carbs + macros.carbs,
        fats: totals.fats + macros.fats,
      };
    },
    { calories: 0, protein: 0, carbs: 0, fats: 0 }
  );

  const requestedTarget = Math.max(0, Math.round(Number(slotTarget) || 0));
  const scaleRatio =
    requestedTarget > 0 && baseTotals.calories > 0 ? requestedTarget / baseTotals.calories : 1;

  let scaledItems = normalizedItems.map((item) =>
    scaleSingleItem(item, Math.max(40, Math.round(item.grams * scaleRatio)))
  );

  let totals = computeTotals(scaledItems);

  if (requestedTarget > 0 && scaledItems.length > 0) {
    const adjustableIndex = scaledItems.findIndex(
      (item) => Number(item?.per100?.calories || 0) > 0
    );
    const finalIndex = adjustableIndex >= 0 ? adjustableIndex : 0;
    const perGramCalories = Number(scaledItems[finalIndex]?.per100?.calories || 0) / 100;
    const calorieDelta = requestedTarget - Math.round(totals.calories);

    if (Math.abs(calorieDelta) > 0 && perGramCalories > 0) {
      const gramAdjustment = calorieDelta / perGramCalories;
      const adjustedGrams = Number(scaledItems[finalIndex].grams || 100) + gramAdjustment;
      scaledItems[finalIndex] = scaleSingleItem(scaledItems[finalIndex], adjustedGrams);
      totals = computeTotals(scaledItems);
    }

    const residualDelta = requestedTarget - Math.round(totals.calories);
    if (residualDelta !== 0) {
      const patched = { ...scaledItems[finalIndex] };
      patched.calories = Math.max(0, Math.round(Number(patched.calories || 0) + residualDelta));
      scaledItems[finalIndex] = patched;
      totals = computeTotals(scaledItems);
    }
  }

  return {
    items: scaledItems,
    totals: normalizeTotals(totals),
    scaleRatio: Math.round(scaleRatio * 1000) / 1000,
  };
};

export const scaleToTarget = (items = [], targetCalories = 0) =>
  scaleComboToTarget(items, targetCalories);
