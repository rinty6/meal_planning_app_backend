import { createClerkClient } from "@clerk/backend";
import { eq, inArray } from "drizzle-orm";

import { db } from "../config/db.js";
import { ENV } from "../config/env.js";
import {
  calorieGoalsTable,
  demographicsTable,
  favouritesTable,
  mealLogsTable,
  mealPlanEventsTable,
  mealPlanPreferencesTable,
  notificationsTable,
  recommendationFeedbackTable,
  recipesTable,
  shoppingItemsTable,
  shoppingListsTable,
  userDevicesTable,
  usersTable,
} from "../db/schema.js";
import { cleanText, getUserByClerkId } from "./userSync.js";

let clerkClientInstance = null;

export class AccountDeletionError extends Error {
  constructor(message, { status = 500, code = "ACCOUNT_DELETION_FAILED", details = null } = {}) {
    super(message);
    this.name = "AccountDeletionError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const getClerkClient = () => {
  if (clerkClientInstance) return clerkClientInstance;

  if (!ENV.CLERK_SECRET_KEY || !ENV.CLERK_SECRET_KEY.startsWith("sk_")) {
    throw new AccountDeletionError("Missing valid Clerk server configuration.", {
      status: 500,
      code: "CLERK_SERVER_UNAVAILABLE",
    });
  }

  clerkClientInstance = createClerkClient({
    secretKey: ENV.CLERK_SECRET_KEY,
  });

  return clerkClientInstance;
};

const countDeleted = async (deleteQuery) => {
  const deletedRows = await deleteQuery.returning();
  return Array.isArray(deletedRows) ? deletedRows.length : 0;
};

const deleteShoppingItemsForLists = async (listIds) => {
  if (listIds.length === 0) return 0;

  return countDeleted(
    db
      .delete(shoppingItemsTable)
      .where(inArray(shoppingItemsTable.listId, listIds))
  );
};

const deleteAppDataForUser = async ({ userId }) => {
  const shoppingLists = await db
    .select({ id: shoppingListsTable.id })
    .from(shoppingListsTable)
    .where(eq(shoppingListsTable.userId, userId));
  const shoppingListIds = shoppingLists.map((item) => item.id);

  const deleted = {};

  deleted.shoppingItems = await deleteShoppingItemsForLists(shoppingListIds);
  deleted.shoppingLists = await countDeleted(
    db.delete(shoppingListsTable).where(eq(shoppingListsTable.userId, userId))
  );
  deleted.mealPlanEvents = await countDeleted(
    db.delete(mealPlanEventsTable).where(eq(mealPlanEventsTable.userId, userId))
  );
  deleted.mealPlanPreferences = await countDeleted(
    db.delete(mealPlanPreferencesTable).where(eq(mealPlanPreferencesTable.userId, userId))
  );
  deleted.recommendationFeedback = await countDeleted(
    db.delete(recommendationFeedbackTable).where(eq(recommendationFeedbackTable.userId, userId))
  );
  deleted.notifications = await countDeleted(
    db.delete(notificationsTable).where(eq(notificationsTable.userId, userId))
  );
  deleted.userDevices = await countDeleted(
    db.delete(userDevicesTable).where(eq(userDevicesTable.userId, userId))
  );
  deleted.favourites = await countDeleted(
    db.delete(favouritesTable).where(eq(favouritesTable.userId, userId))
  );
  deleted.recipes = await countDeleted(
    db.delete(recipesTable).where(eq(recipesTable.userId, userId))
  );
  deleted.mealLogs = await countDeleted(
    db.delete(mealLogsTable).where(eq(mealLogsTable.userId, userId))
  );
  deleted.calorieGoals = await countDeleted(
    db.delete(calorieGoalsTable).where(eq(calorieGoalsTable.userId, userId))
  );
  deleted.demographics = await countDeleted(
    db.delete(demographicsTable).where(eq(demographicsTable.userId, userId))
  );
  deleted.userInfo = await countDeleted(
    db.delete(usersTable).where(eq(usersTable.userId, userId))
  );

  return deleted;
};

const deleteClerkUser = async ({ clerkId }) => {
  try {
    await getClerkClient().users.deleteUser(clerkId);
    return true;
  } catch (error) {
    const status = Number(error?.status) || Number(error?.errors?.[0]?.meta?.status) || 502;
    const isNotFound = status === 404;
    if (isNotFound) return false;

    throw new AccountDeletionError("Failed to delete Clerk account.", {
      status,
      code: "CLERK_ACCOUNT_DELETE_FAILED",
      details: error?.errors?.[0]?.message || error?.message || null,
    });
  }
};

export const deleteAccountForClerkId = async (clerkId) => {
  const normalizedClerkId = cleanText(clerkId);

  if (!normalizedClerkId) {
    throw new AccountDeletionError("Missing authenticated Clerk user id.", {
      status: 401,
      code: "MISSING_AUTHENTICATED_USER",
    });
  }

  const user = await getUserByClerkId(normalizedClerkId);
  if (!user) {
    const clerkDeleted = await deleteClerkUser({ clerkId: normalizedClerkId });

    return {
      success: true,
      clerkId: normalizedClerkId,
      userId: null,
      deleted: {},
      clerkDeleted,
    };
  }

  const deleted = await deleteAppDataForUser({ userId: user.userId });
  const clerkDeleted = await deleteClerkUser({ clerkId: normalizedClerkId });

  return {
    success: true,
    clerkId: normalizedClerkId,
    userId: user.userId,
    deleted,
    clerkDeleted,
  };
};
