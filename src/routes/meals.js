import express from "express";
import { db } from "../config/db.js";
import { mealLogsTable, usersTable } from "../db/schema.js";
import { eq, and } from "drizzle-orm";

// This file will help store meal detail whenever users add a dish at meal planning page
// ENDPOINT: POST /api/meals/add
const mealRoutes = express.Router();

mealRoutes.post("/add", async (req, res) => {
  try {
    const { clerkId, date, mealType, foodName, calories, protein, carbs, fats, image } = req.body;

    // 1. We need to find the internal userId (integer) using the Clerk ID
    const user = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.clerkId, clerkId))
        .limit(1);

    if (user.length === 0) {
        return res.status(404).json({ error: "User not found" });
    }

    const userId = user[0].userId;

    // 2. Insert the meal into the database
    await db.insert(mealLogsTable).values({
        userId: userId,
        date: new Date(date), // Ensure date is formatted correctly
        mealType: mealType,   // 'breakfast', 'lunch', or 'dinner'
        foodName: foodName,
        calories: calories,
        protein: protein || 0, // Default to 0 if FatSecret doesn't give us this
        carbs: carbs || 0,
        fats: fats || 0,
        image: image || "",    // Optional image URL
    });

    res.status(201).json({ success: true, message: "Meal added successfully" });

  } catch (error) {
    console.error("Error adding meal:", error);
    res.status(500).json({ error: "Failed to add meal" });
  }
});

// 2. GET MEAL SUMMARY (Fetch all meals for a specific date)
mealRoutes.get("/summary/:clerkId/:date", async (req, res) => {
    try {
        const { clerkId, date } = req.params;

        // A. Find the internal User ID
        const user = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId)).limit(1);
        if (user.length === 0) return res.status(404).json({ error: "User not found" });
        const userId = user[0].userId;

        // B. Query the Database for meals on that specific date
        // Note: Dates can be tricky. We compare the string version YYYY-MM-DD to match exactly.
        const meals = await db
            .select()
            .from(mealLogsTable)
            .where(and(
                eq(mealLogsTable.userId, userId),
                eq(mealLogsTable.date, new Date(date)) 
            ));

        // C. Send the list back to the app
        res.status(200).json(meals);

    } catch (error) {
        console.error("Error fetching summary:", error);
        res.status(500).json({ error: "Failed to fetch meals" });
    }
});

// 3. DELETE MEAL ITEM
mealRoutes.delete("/delete/:id", async (req, res) => {
    try {
        const { id } = req.params;
        
        await db.delete(mealLogsTable).where(eq(mealLogsTable.id, id));
        
        res.status(200).json({ success: true, message: "Item deleted" });
    } catch (error) {
        console.error("Error deleting item:", error);
        res.status(500).json({ error: "Failed to delete" });
    }
});



export default mealRoutes;
