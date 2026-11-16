// Daily fluid target (checklist m4-06).
//
// Source, copied 2026-11-16: NHMRC Nutrient Reference Values, Water,
//   eatforhealth.gov.au/nutrient-reference-values/nutrients/water
// It is an Adequate Intake (AI), set at median Australian intake, not a
// requirement measured in a trial. The NRV itself says needs vary widely and
// that heat and activity raise them, so this is a sensible daily aim, never a
// limit and never something to warn about when exceeded.
//
// The NRV gives two figures per row:
//   total water   food + drinks (e.g. 3.4 L for men)
//   fluids        drinks only, "including plain water, milk and other drinks"
// The app uses FLUIDS, because the thing measured against it is what the user
// drinks; solid food already supplies the other ~25%. Every drink counts
// toward it (water, tea, coffee, milk, juice), as in the NRV's own definition.
//
// Which row applies, including gender Other, pregnant AND breastfeeding and
// pregnancy at 51+, is decided in lifeStage.js, shared with the serve targets.
// The adult bands do not differ for water, so they repeat the same value.
import { applyLifeStage, resolveLifeStage } from "./lifeStage.js";

const ml = (fluidsMl) => Object.freeze({ fluidsMl });

export const WATER_AI_TABLE = Object.freeze({
  male_14_18: ml(1900),
  female_14_18: ml(1600),
  pregnant_14_18: ml(1800),
  lactating_14_18: ml(2300),

  male_19_50: ml(2600),
  male_51_70: ml(2600),
  male_70_plus: ml(2600),

  female_19_50: ml(2100),
  female_51_70: ml(2100),
  female_70_plus: ml(2100),

  pregnant_19_plus: ml(2300),
  lactating_19_plus: ml(2600),
});

// Midpoints land on 50 mL steps already (2,350 and 1,750); rounding to 50 mL
// keeps any future row on a sensible step too.
const toFiftyMl = (value) => Math.round(value / 50) * 50;

/**
 * @param {object} p  same person shape as resolveServeTargets
 * @returns {{ fluidsMl: number, row: string, source: string }}
 */
export const resolveWaterTarget = (person = {}) => {
  const stage = resolveLifeStage(person);
  return {
    ...applyLifeStage(WATER_AI_TABLE, stage, ["fluidsMl"], toFiftyMl),
    row: stage.row,
    source: stage.source === "known" ? "nrv" : "nrv_default",
  };
};
