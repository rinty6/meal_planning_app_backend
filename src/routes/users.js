// This file will handle the sign-in process
// Whenever a user sign up successfully, all the information will be inserted into the user table

import express from "express"
import { db } from "../config/db.js";
import { usersTable } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { demographicsTable } from "../db/schema.js";

const userRoutes = express.Router();

// ENDPOINT: POST /api/users/sync
userRoutes.post('/sync', async (req, res) => {
    try {
        
        const {clerkId, email, username} = req.body

        // 1. Make sure we have enough necessary data
        if (!clerkId || !email) {
            return res.status(400).json({error: "Missing required fields (clerkid or email)"})
        }

        // 2. Check if user already exists in the database
        const existinguser = await db.
            select()
            .from(usersTable)
            .where(eq(usersTable.clerkId, clerkId), eq(usersTable.email, email));

        if (existinguser.length > 0) {
            return res.status(200).json({message: "User already exists", user: existinguser[0]})
        }

        // 3. Insert the user's detail into the user table
        const newUser = await db.insert(usersTable).values({
            clerkId: clerkId,
            email: email.toLowerCase(),
            username: username.toLowerCase() || "New User",
        }).returning();

        // 4. Send back successful message
        res.status(201).json({
            success: true, user: newUser[0]
        });

    } catch (error) {
        console.error("Error syncing user:", error)
        res.status(500).json({error: "Internal server error"})
    }
}
)

// Check if user has finished onboarding
userRoutes.get('/status/:clerkId', async (req, res) => {
    try {
        const { clerkId } = req.params;

        // 1. Find the User
        const user = await db
            .select()
            .from(usersTable)
            .where(eq(usersTable.clerkId, clerkId))
            .limit(1);

        if (user.length === 0) {
        // User doesn't exist in DB yet -> Needs to go onboarding pages
        return res.json({ hasOnboarded: false });
        }

        const userId = user[0].userId;

        // 2. Check if they have Demographics data
        const demographics = await db
            .select()
            .from(demographicsTable)
            .where(eq(demographicsTable.userId, userId))
            .limit(1);

        if (demographics.length > 0) {
            return res.json({ hasOnboarded: true });
        } else {
            return res.json({ hasOnboarded: false });
        }

    } catch (error) {
        console.error("Error checking status:", error);
        res.status(500).json({ error: "Server error" });
    }
})


export default userRoutes;