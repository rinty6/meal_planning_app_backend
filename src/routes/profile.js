// This routes helps update when users make any changes about their information

import express from "express";
import { db } from "../config/db.js";
import { usersTable, demographicsTable } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { requireClerkAuth, ensureClerkIdMatch, attachUserFromAuth } from "../middleware/auth.js";
import { isValidActivityLevel, resolvePregnancyFields } from "../services/demographicsRules.js";

const profileRoutes = express.Router();

const normalizeDisplayName = (value) =>
    String(value || "").trim().replace(/\s+/g, " ");

// Fetch the user's complete profileac
profileRoutes.get("/:clerkId", requireClerkAuth, ensureClerkIdMatch("params"), attachUserFromAuth, async (req, res) => {
    try {
        const userRecord = req.dbUser;
        const userId = userRecord.userId;

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

        // Profile reads include editable user-facing identity, so avoid serving
        // a stale name immediately after the profile screen saves a change.
        res.set("Cache-Control", "no-store");
        res.json({
            user: userRecord,
            demographics: profileData
        });
    } catch (error) {
        console.error("Error fetching profile:", error);
        res.status(500).json({ error: "Server error while fetching profile" });
    }
});

// Update the user's display name in the app database.
profileRoutes.put("/name/:clerkId", requireClerkAuth, ensureClerkIdMatch("params"), attachUserFromAuth, async (req, res) => {
    try {
        const displayName = normalizeDisplayName(req.body?.name);

        if (!displayName) {
            return res.status(400).json({ error: "Name is required" });
        }

        const updatedUsers = await db
            .update(usersTable)
            .set({ username: displayName })
            .where(eq(usersTable.userId, req.dbUser.userId))
            .returning();

        if (updatedUsers.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        res.set("Cache-Control", "no-store");
        res.json({
            success: true,
            message: "Name updated successfully",
            user: updatedUsers[0],
        });
    } catch (error) {
        console.error("Error updating profile name:", error);
        res.status(500).json({ error: "Failed to update profile name" });
    }
});

// Update the user's physical demographics
profileRoutes.put("/update/:clerkId", requireClerkAuth, ensureClerkIdMatch("params"), attachUserFromAuth, async (req, res) => {
    try {
        const { weight, height, gender, activityLevel, goal, isPregnant, isBreastfeeding } = req.body;
        const userId = req.dbUser.userId;

        // Same rule as the onboarding save, from the same shared file. Without
        // it, a value outside the activity_level enum came back as a 500.
        if (activityLevel !== undefined && !isValidActivityLevel(activityLevel)) {
            return res.status(400).json({
                error: "Unrecognised activity level.",
                code: "INVALID_ACTIVITY_LEVEL",
            });
        }

        // The edit screen never sends gender, so the pregnancy rule has to be
        // applied against the gender being SAVED: the new one if this request
        // changes it, otherwise the stored one. Checking only the request would
        // let a male user keep is_pregnant = true.
        const [stored] = await db
            .select({ gender: demographicsTable.gender })
            .from(demographicsTable)
            .where(eq(demographicsTable.userId, userId))
            .limit(1);
        const pregnancy = resolvePregnancyFields({
            gender: gender ?? stored?.gender,
            isPregnant,
            isBreastfeeding,
            // A partial edit: a field not sent is left exactly as it is.
            skippedMeansNull: false,
        });

        // `age` used to be passed here too. There is no age column (age is
        // derived from date_of_birth), so Drizzle silently dropped it and the
        // route still reported success. Removed rather than left as a trap;
        // the edit screen never sent it anyway. Making age editable is a
        // separate change: it has to write date_of_birth.
        await db.update(demographicsTable).set({
            weight: Number(weight),
            height: Number(height),
            gender,
            activityLevel,
            goal,
            isPregnant: pregnancy.isPregnant,
            isBreastfeeding: pregnancy.isBreastfeeding,
            updatedAt: new Date()
        }).where(eq(demographicsTable.userId, userId));

        res.json({ success: true, message: "Profile updated successfully" });
    } catch (error) {
        console.error("Error updating profile:", error);
        res.status(500).json({ error: "Failed to update profile" });
    }
});

export default profileRoutes;
