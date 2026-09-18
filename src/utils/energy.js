// Energy units for user-visible text rendered on the server (push bodies,
// insight summaries). Twin of meal_app/utils/energy.ts: numbers are stored and
// computed in kcal; anything a person reads is kJ (decided 2026-09-18, the app
// is for an Australian audience). Same constant, same rounding, same grouping.

export const KJ_PER_KCAL = 4.184;

export const kcalToKj = (kcal) => Number(kcal) * KJ_PER_KCAL;

const groupThousands = (integer) => String(Math.abs(integer)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** formatEnergyKj(2000) → "8,368 kJ". Unknown → "–". Negative → "0 kJ". */
export const formatEnergyKj = (kcal, { withUnit = true } = {}) => {
  if (kcal === null || kcal === undefined || kcal === "") return "–";
  const value = Number(kcal);
  if (!Number.isFinite(value)) return "–";
  const text = groupThousands(Math.max(0, Math.round(kcalToKj(value))));
  return withUnit ? `${text} kJ` : text;
};
