// This routes helps update when users make any changes about their information

import express from "express";
import { db } from "../config/db.js";
import { usersTable, demographicsTable } from "../db/schema.js";
import { eq } from "drizzle-orm";

const profileRoutes = express.Router();

// Fetch the user's complete profileac
profileRoutes.get("/:clerkId", async (req, res) => {
    try {
        const { clerkId } = req.params;
        const user = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId)).limit(1);
        
        if (user.length === 0) return res.status(404).json({ error: "User not found" });
        const userId = user[0].userId;

        const demographics = await db.select().from(demographicsTable).where(eq(demographicsTable.userId, userId)).limit(1);

        let profileData = demographics.length > 0 ? demographics[0] : null;

        // FIX: Correctly look for dateOfBirth instead of dob!
        if (profileData && profileData.dateOfBirth) {
            const dob = new Date(profileData.dateOfBirth);
            const today = new Date();
            let age = today.getFullYear() - dob.getFullYear();
            const monthDiff = today.getMonth() - dob.getMonth();
            if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
                age--;
            }
            profileData.age = age; // Attach the calculated age to the payload
        } else if (profileData && profileData.age === undefined) {
             profileData.age = "N/A"; // Failsafe
        }

        // Let the iOS NSURLCache serve repeated profile reads from the device
        // for a short window. Same-device edits update the in-memory cache
        // synchronously, so this only shortens cross-device / cold-cache reads.
        res.set("Cache-Control", "private, max-age=30");
        res.json({
            user: user[0],
            demographics: profileData
        });
    } catch (error) {
        console.error("Error fetching profile:", error);
        res.status(500).json({ error: "Server error while fetching profile" });
    }
});

// Update the user's physical demographics
profileRoutes.put("/update/:clerkId", async (req, res) => {
    try {
        const { clerkId } = req.params;
        const { weight, height, age, gender, activityLevel, goal } = req.body;

        const user = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId)).limit(1);
        if (user.length === 0) return res.status(404).json({ error: "User not found" });
        const userId = user[0].userId;

        // Update the demographics table
        await db.update(demographicsTable).set({
            weight: Number(weight),
            height: Number(height),
            age: Number(age),
            gender,
            activityLevel,
            goal,
            updatedAt: new Date()
        }).where(eq(demographicsTable.userId, userId));

        res.json({ success: true, message: "Profile updated successfully" });
    } catch (error) {
        console.error("Error updating profile:", error);
        res.status(500).json({ error: "Failed to update profile" });
    }
});

export default profileRoutes;