// This file handles the shopping process
import express from "express";
import { db } from "../config/db.js";
import { shoppingListsTable, shoppingItemsTable, usersTable } from "../db/schema.js";
import { eq, desc, sql } from "drizzle-orm";

const shoppingRoutes = express.Router();

// 1. GET ALL LISTS FOR USER
shoppingRoutes.get("/list/:clerkId", async (req, res) => {
  try {
    const { clerkId } = req.params;
    
    // Get User ID
    const user = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId)).limit(1);
    if (user.length === 0) return res.status(404).json({ error: "User not found" });
    const userId = user[0].userId;

    // Fetch lists with item counts in one query instead of one count query per list.
    const lists = await db
      .select({
        id: shoppingListsTable.id,
        userId: shoppingListsTable.userId,
        title: shoppingListsTable.title,
        createdAt: shoppingListsTable.createdAt,
        itemCount: sql`cast(count(${shoppingItemsTable.id}) as int)`,
      })
      .from(shoppingListsTable)
      .leftJoin(shoppingItemsTable, eq(shoppingItemsTable.listId, shoppingListsTable.id))
      .where(eq(shoppingListsTable.userId, userId))
      .groupBy(shoppingListsTable.id, shoppingListsTable.userId, shoppingListsTable.title, shoppingListsTable.createdAt)
      .orderBy(desc(shoppingListsTable.createdAt));

    res.json(lists.map((list) => ({ ...list, itemCount: Number(list.itemCount) || 0 })));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error" });
  }
});

// 2. CREATE NEW LIST (Empty or Imported)
shoppingRoutes.post("/create", async (req, res) => {
  try {
    const { clerkId, title, items } = req.body; // items is an array of strings ["Egg", "Milk"]

    const user = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId)).limit(1);
    if (user.length === 0) return res.status(404).json({ error: "User not found" });
    const userId = user[0].userId;

    // A. Create the List
    const newList = await db.insert(shoppingListsTable).values({
        userId,
        title: title || "New Shopping List"
    }).returning();
    
    const listId = newList[0].id;

    // B. Add Items (if any)
    if (items && items.length > 0) {
        const itemsToInsert = items.map(name => ({
            listId,
            name,
            isChecked: false
        }));
        await db.insert(shoppingItemsTable).values(itemsToInsert);
    }

    res.status(201).json({ success: true, listId });
  } catch (error) {
    console.error("Create List Error:", error);
    res.status(500).json({ error: "Failed to create list" });
  }
});

// 3. GET LIST DETAILS
shoppingRoutes.get("/detail/:listId", async (req, res) => {
  try {
    const { listId } = req.params;
    const items = await db.select().from(shoppingItemsTable).where(eq(shoppingItemsTable.listId, listId));
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: "Error fetching items" });
  }
});

// 4. TOGGLE ITEM CHECK
shoppingRoutes.put("/toggle/:itemId", async (req, res) => {
  try {
    const { itemId } = req.params;
    const { isChecked } = req.body;
    await db.update(shoppingItemsTable).set({ isChecked }).where(eq(shoppingItemsTable.id, itemId));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Error updating item" });
  }
});

// 5. ADD SINGLE ITEM
shoppingRoutes.post("/add-item", async (req, res) => {
  try {
    const { listId, name } = req.body;
    await db.insert(shoppingItemsTable).values({ listId, name, isChecked: false });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Error adding item" });
  }
});

// 6. DELETE LIST
shoppingRoutes.delete("/delete/:listId", async (req, res) => {
  try {
    const { listId } = req.params;
    // Items cascade delete automatically due to schema definition
    await db.delete(shoppingListsTable).where(eq(shoppingListsTable.id, listId));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Delete failed" });
  }
});

shoppingRoutes.put("/update-item/:itemId", async (req, res) => {
  try {
    const { itemId } = req.params;
    const { name } = req.body;
    
    await db.update(shoppingItemsTable)
      .set({ name })
      .where(eq(shoppingItemsTable.id, itemId));
      
    res.json({ success: true });
  } catch (e) {
    console.error("Update Item Error:", e);
    res.status(500).json({ error: "Error updating item" });
  }
});

// 8. DELETE SINGLE ITEM
shoppingRoutes.delete("/delete-item/:itemId", async (req, res) => {
  try {
    const { itemId } = req.params;
    await db.delete(shoppingItemsTable).where(eq(shoppingItemsTable.id, itemId));
    res.json({ success: true });
  } catch (e) {
    console.error("Delete Item Error:", e);
    res.status(500).json({ error: "Failed to delete item" });
  }
});

// 9. RESET LIST (Uncheck all items)
shoppingRoutes.put("/reset-list/:listId", async (req, res) => {
  try {
    const { listId } = req.params;
    // Set isChecked = false for ALL items in this list
    await db.update(shoppingItemsTable)
      .set({ isChecked: false })
      .where(eq(shoppingItemsTable.listId, listId));
      
    res.json({ success: true });
  } catch (e) {
    console.error("Reset List Error:", e);
    res.status(500).json({ error: "Failed to reset list" });
  }
});

export default shoppingRoutes;
