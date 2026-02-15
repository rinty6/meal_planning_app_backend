import express from "express";
import { db } from "../config/db.js";
import { eq } from "drizzle-orm";
import { demographicsTable, usersTable } from "../db/schema.js";

// This file will help store all user's background details
// I will these when building machine learning model and meal generating model;

const demographicsRoutes = express.Router();

demographicsRoutes.post("/save", async (req, res) => {
    try {
        const {
            clerkId,
            age,
            gender, 
            weight, 
            height, 
            activityLevel, 
            goal,
            weightUnit,
            heightUnit
        } = req.body;

    // 1. Find the internal User ID based on Clerk ID
    const user = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.clerkId, clerkId))
        .limit(1);

    if (user.length === 0) {
        return res.status(404).json({error: "User not found"});
    }

    const userId = user[0].userId;

    // 2. Convert Age to Approximate Date of Birth (Schema requires Date)
    const currentYear = new Date().getFullYear();
    const birthYear = currentYear - parseInt(age);
    const approxDob = new Date(`${birthYear}-01-01`); // Default to Jan 1st

    // 3. Insert or Update Demographics
    await db.insert(demographicsTable).values({
      userId: userId,
      gender: gender.toLowerCase(), // Ensure matches enum ('male', 'female', 'other')
      dateOfBirth: approxDob, 
      weight: parseFloat(weight),
      height: parseFloat(height),
      preferredWeightUnit: weightUnit, // 'kg' or 'lbs'
      preferredHeightUnit: heightUnit, // 'cm' or 'ft'
      activityLevel: activityLevel,
      goal: goal,
    });
    
    res.status(201).json({ success: true, message: "Profile completed!" });

    } catch (error) {
        console.error("Error saving demographics:", error);
        res.status(500).json({ error: "Failed to save data" });
    }
})

export default demographicsRoutes;