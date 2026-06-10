// This file handles the shopping process
import express from "express";
import { db } from "../config/db.js";
import { shoppingListsTable, shoppingItemsTable } from "../db/schema.js";
import { and, eq, desc, sql } from "drizzle-orm";
import { requireClerkAuth, ensureClerkIdMatch, attachUserFromAuth } from "../middleware/auth.js";

const shoppingRoutes = express.Router();

// Shopping items have no userId of their own — they belong to a list. Item-level
// routes must prove the parent list belongs to the current user before mutating.
const userOwnsList = async (listId, userId) => {
  const rows = await db
    .select({ id: shoppingListsTable.id })
    .from(shoppingListsTable)
    .where(and(eq(shoppingListsTable.id, listId), eq(shoppingListsTable.userId, userId)))
    .limit(1);
  return rows.length > 0;
};

const userOwnsItem = async (itemId, userId) => {
  const rows = await db
    .select({ id: shoppingItemsTable.id })
    .from(shoppingItemsTable)
    .innerJoin(shoppingListsTable, eq(shoppingItemsTable.listId, shoppingListsTable.id))
    .where(and(eq(shoppingItemsTable.id, itemId), eq(shoppingListsTable.userId, userId)))
    .limit(1);
  return rows.length > 0;
};

// 1. GET ALL LISTS FOR USER
shoppingRoutes.get("/list/:clerkId", requireClerkAuth, ensureClerkIdMatch("params"), attachUserFromAuth, async (req, res) => {
  try {
    const userId = req.dbUser.userId;

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
shoppingRoutes.post("/create", requireClerkAuth, ensureClerkIdMatch("body"), attachUserFromAuth, async (req, res) => {
  try {
    const { title, items } = req.body; // items is an array of strings ["Egg", "Milk"]
    const userId = req.dbUser.userId;

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
shoppingRoutes.get("/detail/:listId", requireClerkAuth, attachUserFromAuth, async (req, res) => {
  try {
    const { listId } = req.params;
    if (!(await userOwnsList(listId, req.dbUser.userId))) {
      return res.status(404).json({ error: "List not found" });
    }
    const items = await db.select().from(shoppingItemsTable).where(eq(shoppingItemsTable.listId, listId));
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: "Error fetching items" });
  }
});

// 4. TOGGLE ITEM CHECK
shoppingRoutes.put("/toggle/:itemId", requireClerkAuth, attachUserFromAuth, async (req, res) => {
  try {
    const { itemId } = req.params;
    const { isChecked } = req.body;
    if (!(await userOwnsItem(itemId, req.dbUser.userId))) {
      return res.status(404).json({ error: "Item not found" });
    }
    await db.update(shoppingItemsTable).set({ isChecked }).where(eq(shoppingItemsTable.id, itemId));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Error updating item" });
  }
});

// 5. ADD SINGLE ITEM
shoppingRoutes.post("/add-item", requireClerkAuth, attachUserFromAuth, async (req, res) => {
  try {
    const { listId, name } = req.body;
    if (!(await userOwnsList(listId, req.dbUser.userId))) {
      return res.status(404).json({ error: "List not found" });
    }
    await db.insert(shoppingItemsTable).values({ listId, name, isChecked: false });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Error adding item" });
  }
});

// 6. DELETE LIST
shoppingRoutes.delete("/delete/:listId", requireClerkAuth, attachUserFromAuth, async (req, res) => {
  try {
    const { listId } = req.params;
    // Items cascade delete automatically due to schema definition
    const deleted = await db
      .delete(shoppingListsTable)
      .where(and(eq(shoppingListsTable.id, listId), eq(shoppingListsTable.userId, req.dbUser.userId)))
      .returning();
    if (deleted.length === 0) {
      return res.status(404).json({ error: "List not found" });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Delete failed" });
  }
});

shoppingRoutes.put("/update-item/:itemId", requireClerkAuth, attachUserFromAuth, async (req, res) => {
  try {
    const { itemId } = req.params;
    const { name } = req.body;

    if (!(await userOwnsItem(itemId, req.dbUser.userId))) {
      return res.status(404).json({ error: "Item not found" });
    }

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
shoppingRoutes.delete("/delete-item/:itemId", requireClerkAuth, attachUserFromAuth, async (req, res) => {
  try {
    const { itemId } = req.params;
    if (!(await userOwnsItem(itemId, req.dbUser.userId))) {
      return res.status(404).json({ error: "Item not found" });
    }
    await db.delete(shoppingItemsTable).where(eq(shoppingItemsTable.id, itemId));
    res.json({ success: true });
  } catch (e) {
    console.error("Delete Item Error:", e);
    res.status(500).json({ error: "Failed to delete item" });
  }
});

// 9. RESET LIST (Uncheck all items)
shoppingRoutes.put("/reset-list/:listId", requireClerkAuth, attachUserFromAuth, async (req, res) => {
  try {
    const { listId } = req.params;
    if (!(await userOwnsList(listId, req.dbUser.userId))) {
      return res.status(404).json({ error: "List not found" });
    }
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
