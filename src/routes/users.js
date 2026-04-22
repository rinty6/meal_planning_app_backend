// This file will handle the sign-in process
// Whenever a user sign up successfully, all the information will be inserted into the user table

import express from "express"
import { userDevicesTable, usersTable } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { db } from "../config/db.js";
import {
    bootstrapUserFromClerkId,
    getHasOnboarded,
    getUserByClerkId,
    syncUserRecord,
} from "../services/userSync.js";
import { requireClerkAuth } from "../middleware/auth.js";

const userRoutes = express.Router();

const logUserBootstrap = (payload) => {
    console.log("user.bootstrap", payload);
};

// ENDPOINT: POST /api/users/sync
userRoutes.post('/sync', async (req, res) => {
    try {
        const { clerkId, email, username } = req.body;
        const syncResult = await syncUserRecord({ clerkId, email, username });

        if (!syncResult.ok) {
            return res.status(syncResult.status || 500).json({
                error: syncResult.error || "Failed to sync user",
                code: syncResult.code || "USER_SYNC_FAILED",
            });
        }

        return res.status(syncResult.status || 200).json({
            success: true,
            action: syncResult.action,
            user: syncResult.user,
        });

    } catch (error) {
        console.error("Error syncing user:", error)
        res.status(500).json({error: "Internal server error"})
    }
}
)

userRoutes.post('/bootstrap', requireClerkAuth, async (req, res) => {
    try {
        const clerkId = req.auth?.clerkId;
        const bootstrapResult = await bootstrapUserFromClerkId(clerkId);

        if (!bootstrapResult.ok) {
            logUserBootstrap({
                level: "warn",
                clerkId,
                status: bootstrapResult.status || 500,
                code: bootstrapResult.code || "USER_BOOTSTRAP_FAILED",
                error: bootstrapResult.error,
            });

            return res.status(bootstrapResult.status || 500).json({
                error: bootstrapResult.error || "Failed to bootstrap user.",
                code: bootstrapResult.code || "USER_BOOTSTRAP_FAILED",
            });
        }

        logUserBootstrap({
            level: "info",
            clerkId,
            action: bootstrapResult.action,
            email: bootstrapResult.identity?.email || null,
            hasOnboarded: bootstrapResult.hasOnboarded,
        });

        return res.status(bootstrapResult.status || 200).json({
            success: true,
            action: bootstrapResult.action,
            user: bootstrapResult.user,
            hasOnboarded: bootstrapResult.hasOnboarded,
        });
    } catch (error) {
        console.error("Error bootstrapping user:", error);
        return res.status(500).json({
            error: "Internal server error",
            code: "USER_BOOTSTRAP_EXCEPTION",
        });
    }
});

// Check if user has finished onboarding
userRoutes.get('/status/:clerkId', async (req, res) => {
    try {
        const { clerkId } = req.params;

        // 1. Find the User
        const user = await getUserByClerkId(clerkId);

        if (!user) {
        // User doesn't exist in DB yet -> Needs to go onboarding pages
        return res.json({ hasOnboarded: false });
        }

        const hasOnboarded = await getHasOnboarded(user.userId);
        return res.json({ hasOnboarded });

    } catch (error) {
        console.error("Error checking status:", error);
        res.status(500).json({ error: "Server error" });
    }
})

userRoutes.post('/save-token', async (req, res) => {
    const { clerkId, token, platform } = req.body;
    try {
        if (!clerkId || !token) {
            return res.status(400).json({ error: "Missing clerkId or token" });
        }

        const user = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId)).limit(1);
        if (user.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        await db.insert(userDevicesTable)
            .values({
                userId: user[0].userId,
                pushToken: String(token).trim(),
                platform: String(platform || "unknown").toLowerCase(),
                updatedAt: new Date(),
            })
            .onConflictDoUpdate({
                target: userDevicesTable.pushToken,
                set: {
                    userId: user[0].userId,
                    platform: String(platform || "unknown").toLowerCase(),
                    updatedAt: new Date(),
                },
            });

        console.log(`Successfully saved token for user ${clerkId}`);
        res.status(200).json({ success: true, message: "Token saved successfully" });
    } catch (error) {
        console.error("Error saving push token:", error);
        res.status(500).json({ error: "Failed to save push token" });
    }
});

export default userRoutes;
