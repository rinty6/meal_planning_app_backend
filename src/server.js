import express from 'express';
import 'dotenv/config';
import { ENV } from './config/env.js';
import { db } from './config/db.js';
import { favouritesTable } from './db/schema.js';
import { and, eq} from 'drizzle-orm';
import job from './config/cron.js';

const app = express();
const PORT = ENV.PORT || 3000;

if (ENV.NODE_ENV === "production") {job.start();}

app.use(express.json());

app.get("/api/health", (req, res) => {
  res.status(200).json({success: true});
});


// Get the data from dish Meal Plan page and save to favorites table if user clicks "Save to Favorites" icon
app.post("/api/favorites", async (req, res) => {
  try {
    const {userId, recipeId, title, image, cookTime, servings} = req.body;

    // check for missing fields when saving to favorites
    if (!userId || !recipeId || !title || !image || !cookTime || !servings) {
      return res.status(400).json({error: "Missing required fields"});
    }

    // Insert into favorites table
    const newFavorites = await db.insert(favouritesTable).values({
      userId,
      recipeId, 
      title, 
      image, 
      cookTime, 
      servings
    }).returning();
      res.status(201).json(newFavorites[0]);
  } catch (error) {
    console.error("Error saving to favorites:", error);
    res.status(500).json({error: "Internal server error"});
  }
});

// Delete a favorite Id if user clicks the "Remove from Favorites" icon at Meal Plan page
// Take the user ID and recipe ID as params to identify the favorite to be deleted
app.delete("/api/favorites/:userId/:recipeId", async (req, res) => {
  try {
    const {userId, recipeId} = req.params; 
  
    await db.delete(favouritesTable).where(
      and(eq(favouritesTable.userId, userId), eq(favouritesTable.recipeId, parseInt(recipeId)))
    )
    res.status(200).json({message: "Favorite deleted successfully"});
  } catch (error) {
    console.error("Error deleting favorite:", error);
    res.status(500).json({error: "Internal server error"});
  }

})

// This endpoint fetches all favorite recipes for a specific user 
// It will display the saved favorite recipes on the Favorite Meal Page
app.get("/api/favorites/:userId", async (req, res) => {
  try {
    const {userId} = req.params;
    const userFavorites = await db.select().from(favouritesTable).where(eq(favouritesTable.userId, userId));
    res.status(200).json(userFavorites);
  } catch (error) {
    console.error("Error fetching favorite:", error);
    res.status(500).json({error: "Internal server error"});
  }
});


app.listen(PORT, () => {
  console.log('Server is running on port:', PORT);
});