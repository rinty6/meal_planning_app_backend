// The water row on Home and Meal Summary (checklist m6-02,
// WATER_TOTAL_DESIGN.html, 2026-11-25).
//
//   GET    /api/water/:clerkId?date=YYYY-MM-DD       the day's total and target
//   POST   /api/water/add          { clerkId, date, ml? }   one glass (250 ml)
//   DELETE /api/water/:clerkId/last?date=YYYY-MM-DD  takes back the newest glass
//   DELETE /api/water/:clerkId/:id                   one glass (the toast's Undo)
//
// Every answer is the day's new state, so the row never has to add numbers up itself.
import express from "express";
import { and, eq } from "drizzle-orm";

import { db } from "../config/db.js";
import { waterLogsTable } from "../db/schema.js";
import { getDailyCalorieTargetContext } from "../services/dailyCalorieTarget.js";
import { GLASS_ML, MAX_WATER_ML, findLastGlass, readWaterDay } from "../services/waterIntake.js";
import { requireClerkAuth, ensureClerkIdMatch, attachUserFromAuth } from "../middleware/auth.js";

const waterRoutes = express.Router();

const normalizeDateString = (rawDate) => {
  if (typeof rawDate !== "string") return null;
  const dateStr = rawDate.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : null;
};

const parsePositiveIntegerId = (value) => {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const dayState = async (userId, dateStr) => {
  const context = await getDailyCalorieTargetContext({ db, userId, dateStr });
  return readWaterDay({ db, userId, dateStr, targetMl: context?.waterTarget?.fluidsMl });
};

waterRoutes.get("/:clerkId", requireClerkAuth, ensureClerkIdMatch("params"), attachUserFromAuth, async (req, res) => {
  try {
    const dateStr = normalizeDateString(req.query.date);
    if (!dateStr) return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });
    res.status(200).json(await dayState(req.dbUser.userId, dateStr));
  } catch (error) {
    console.error("Error fetching water:", error);
    res.status(500).json({ error: "Failed to fetch water" });
  }
});

waterRoutes.post("/add", requireClerkAuth, ensureClerkIdMatch("body"), attachUserFromAuth, async (req, res) => {
  try {
    const dateStr = normalizeDateString(req.body?.date);
    if (!dateStr) return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });
    const ml = req.body?.ml === undefined ? GLASS_ML : Math.round(Number(req.body.ml));
    if (!Number.isFinite(ml) || ml <= 0 || ml > MAX_WATER_ML) {
      return res.status(400).json({ error: `ml must be between 1 and ${MAX_WATER_ML}` });
    }
    const userId = req.dbUser.userId;
    const [row] = await db.insert(waterLogsTable).values({ userId, date: dateStr, ml }).returning({ id: waterLogsTable.id });
    res.status(201).json({ addedId: row?.id ?? null, ...(await dayState(userId, dateStr)) });
  } catch (error) {
    console.error("Error adding water:", error);
    res.status(500).json({ error: "Failed to add water" });
  }
});

waterRoutes.delete("/:clerkId/last", requireClerkAuth, ensureClerkIdMatch("params"), attachUserFromAuth, async (req, res) => {
  try {
    const dateStr = normalizeDateString(req.query.date);
    if (!dateStr) return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });
    const userId = req.dbUser.userId;
    const last = await findLastGlass({ db, userId, dateStr });
    if (last) {
      await db.delete(waterLogsTable).where(and(eq(waterLogsTable.id, last.id), eq(waterLogsTable.userId, userId)));
    }
    res.status(200).json(await dayState(userId, dateStr));
  } catch (error) {
    console.error("Error removing water:", error);
    res.status(500).json({ error: "Failed to remove water" });
  }
});

waterRoutes.delete("/:clerkId/:id", requireClerkAuth, ensureClerkIdMatch("params"), attachUserFromAuth, async (req, res) => {
  try {
    const id = parsePositiveIntegerId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid id" });
    const userId = req.dbUser.userId;
    const [removed] = await db
      .delete(waterLogsTable)
      .where(and(eq(waterLogsTable.id, id), eq(waterLogsTable.userId, userId)))
      .returning({ date: waterLogsTable.date });
    if (!removed) return res.status(404).json({ error: "Not found" });
    res.status(200).json(await dayState(userId, String(removed.date).slice(0, 10)));
  } catch (error) {
    console.error("Error removing water:", error);
    res.status(500).json({ error: "Failed to remove water" });
  }
});

export default waterRoutes;
