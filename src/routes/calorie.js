// This route handles the processes at the goal setting page

import express from "express";
import { db } from "../config/db.js";
import { calorieGoalsTable, usersTable, mealLogsTable } from "../db/schema.js";
import { eq, desc, sql } from "drizzle-orm";

const calorieRoutes = express.Router();

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
        notificationsEnabled
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

    const goals = await db.select().from(calorieGoalsTable).where(eq(calorieGoalsTable.userId, userId)).orderBy(desc(calorieGoalsTable.createdAt));
    res.json(goals);
  } catch (error) {
    console.error("Fetch Goals Error:", error);
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

    await db.update(calorieGoalsTable)
      .set({
        goalName,
        dailyCalories: parseInt(dailyCalories),
        description,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        notificationsEnabled,
        updatedAt: new Date()
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
    const { clerkId, date } = req.params; // date format: YYYY-MM-DD

    // 1. Get User ID
    const user = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId)).limit(1);
    if (user.length === 0) return res.status(404).json({ error: "User not found" });
    const userId = user[0].userId;

    // 2. Get Latest Active Goal
    // We assume the most recently created goal is the active one
    const goals = await db.select()
        .from(calorieGoalsTable)
        .where(eq(calorieGoalsTable.userId, userId))
        .orderBy(desc(calorieGoalsTable.createdAt))
        .limit(1);
    
    const target = goals.length > 0 ? goals[0] : { 
        id: 'default', 
        dailyCalories: 2000, 
        goalName: "Daily Target" 
    };

    // 3. Get Meals for the specific date
    const meals = await db.select()
        .from(mealLogsTable)
        .where(
            // Check both userId and date
            // Note: date comparison might vary based on your DB (Postgres/MySQL)
            // This is a generic string comparison for MVP
            sql`${mealLogsTable.userId} = ${userId} AND ${mealLogsTable.date} = ${date}`
        );

    // 4. Calculate Totals
    let totalCalories = 0;
    let totalProtein = 0;
    let totalCarbs = 0;
    let totalFats = 0;

    meals.forEach(meal => {
        totalCalories += meal.calories || 0;
        totalProtein += meal.protein || 0;
        totalCarbs += meal.carbs || 0;
        totalFats += meal.fats || 0;
    });

    // 5. Return Data
    res.json({
        goal: target,
        consumed: {
            calories: Math.round(totalCalories),
            protein: Math.round(totalProtein),
            carbs: Math.round(totalCarbs),
            fats: Math.round(totalFats)
        },
        remaining: Math.max(0, target.dailyCalories - totalCalories)
    });

  } catch (error) {
    console.error("Summary Error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

export default calorieRoutes;