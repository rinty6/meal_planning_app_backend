// This file with connect the database to the machine learning model

import express from "express";
import fetch from 'node-fetch'; 
import { db } from "../config/db.js";
import { usersTable, demographicsTable } from "../db/schema.js";
import { eq } from "drizzle-orm";

const recommendationRoutes = express.Router();

recommendationRoutes.get('/:clerkId', async (req, res) => {
    try {
        const { clerkId } = req.params;

        // 1. Get User Data from DB
        const user = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId)).limit(1);
        if (!user.length) return res.status(404).json({ error: "User not found" });
        
        const demo = await db.select().from(demographicsTable).where(eq(demographicsTable.userId, user[0].userId)).limit(1);
        if (!demo.length) return res.status(400).json({ error: "No demographics found" });

        // 2. CALL PYTHON SERVICE (The Microservice Request)
        // We calculate Age here because dateOfBirth is in DB
        const dob = new Date(demo[0].dateOfBirth);
        const age = new Date().getFullYear() - dob.getFullYear();

        const pythonPayload = {
            userId: user[0].userId,
            demographics: {
                ...demo[0],
                age: age
            }
        };

        // Hit the Flask API running on port 5001
        const mlResponse = await fetch('http://192.168.68.53:5001/recommend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pythonPayload)
        });
        
        const mlData = await mlResponse.json();

        // 3. USE ML DATA TO FETCH RECIPES (FatSecret)
        // The ML gave us the "Smart Query" (e.g. "Chicken") and "Calorie Targets"
        const token = await getFatSecretToken(); // (Reuse your existing token logic)
        
        const params = new URLSearchParams({
            method: 'recipes.search',
            search_expression: mlData.search_term, // ML generated term
            format: 'json',
            max_results: '20'
        });

        const fsResponse = await fetch(`https://platform.fatsecret.com/rest/server.api?${params}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const fsData = await fsResponse.json();
        
        // 4. FILTER RESULTS (Apply the ML calorie targets)
        let recipes = fsData.recipes?.recipe || [];
        if (!Array.isArray(recipes)) recipes = [recipes];

        const recommended = recipes.map(r => ({
             id: r.recipe_id,
             title: r.recipe_name,
             image: r.recipe_image,
             calories: parseInt(r.recipe_nutrition?.calories || 0),
             ml_tag: mlData.search_term // Tag the recipe so UI knows why it's there
        }))
        .filter(r => r.calories <= mlData.meal_calories + 200) // Smart Filtering
        .slice(0, 5);

        res.json({ recommended, meta: mlData });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Recommendation failed" });
    }
});

// Helper for FatSecret Token (Same as before)
// ...
export default recommendationRoutes;