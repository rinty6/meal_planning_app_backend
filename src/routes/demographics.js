import express from "express";
import { db } from "../config/db.js";
import { eq } from "drizzle-orm";
import { demographicsTable } from "../db/schema.js";
import { attachUserFromAuth, requireClerkAuth } from "../middleware/auth.js";
import { isValidActivityLevel, resolvePregnancyFields } from "../services/demographicsRules.js";

// This file will help store all user's background details
// I will these when building machine learning model and meal generating model;

const demographicsRoutes = express.Router();

const logDemographicsSave = (payload) => {
    console.log("demographics.save", payload);
};

demographicsRoutes.post("/save", requireClerkAuth, attachUserFromAuth, async (req, res) => {
    try {
        const {
            age,
            gender, 
            weight, 
            height, 
            activityLevel, 
            goal,
            weightUnit,
            heightUnit,
            isPregnant,
            isBreastfeeding,
        } = req.body;

        if (!age || !gender || !weight || !height || !activityLevel || !goal) {
            return res.status(400).json({
                error: "Missing required onboarding fields.",
                code: "INVALID_DEMOGRAPHICS_PAYLOAD",
            });
        }

        // Without this, a value outside the activity_level enum reached the
        // database and came back as a 500. It is the client's mistake, so 400.
        if (!isValidActivityLevel(activityLevel)) {
            return res.status(400).json({
                error: "Unrecognised activity level.",
                code: "INVALID_ACTIVITY_LEVEL",
            });
        }

        const parsedAge = Number.parseInt(String(age), 10);
        const parsedWeight = Number.parseFloat(String(weight));
        const parsedHeight = Number.parseFloat(String(height));

        if (
            !Number.isFinite(parsedAge) ||
            !Number.isFinite(parsedWeight) ||
            !Number.isFinite(parsedHeight)
        ) {
            return res.status(400).json({
                error: "Age, weight, and height must be valid numbers.",
                code: "INVALID_DEMOGRAPHICS_VALUES",
            });
        }

        const userId = req.dbUser.userId;
        const clerkId = req.auth?.clerkId;

        // Approximate DOB from age so the existing schema stays unchanged.
        const currentYear = new Date().getFullYear();
        const birthYear = currentYear - parsedAge;
        const approxDob = new Date(`${birthYear}-01-01`);

        const normalizedGender = String(gender).toLowerCase();

        // Onboarding is the whole profile in one go, so a field the step did
        // not send (skipped, or never shown to a male user) is stored as NULL,
        // "not stated". That also matters for the upsert below: re-running
        // onboarding as Male clears any answers from an earlier run.
        const pregnancy = resolvePregnancyFields({
            gender: normalizedGender,
            isPregnant,
            isBreastfeeding,
            skippedMeansNull: true,
        });

        const demographicsPayload = {
            userId,
            gender: normalizedGender,
            dateOfBirth: approxDob,
            weight: parsedWeight,
            height: parsedHeight,
            preferredWeightUnit: weightUnit,
            preferredHeightUnit: heightUnit,
            activityLevel,
            goal,
            isPregnant: pregnancy.isPregnant,
            isBreastfeeding: pregnancy.isBreastfeeding,
        };

        await db.insert(demographicsTable)
            .values(demographicsPayload)
            .onConflictDoUpdate({
                target: demographicsTable.userId,
                set: {
                    ...demographicsPayload,
                    updatedAt: new Date(),
                },
            });

        logDemographicsSave({
            level: "info",
            clerkId,
            userId,
            goal,
            activityLevel,
        });

        res.status(201).json({ success: true, message: "Profile completed!" });

    } catch (error) {
        console.error("Error saving demographics:", error);
        res.status(500).json({
            error: "Failed to save data",
            code: "DEMOGRAPHICS_SAVE_FAILED",
        });
    }
})

export default demographicsRoutes;
