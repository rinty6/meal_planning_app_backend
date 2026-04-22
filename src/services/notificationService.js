// This service helps delete old message to clean the database
// It also inserts the notification message to tthe database

import { Expo } from "expo-server-sdk";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { db } from "../config/db.js";
import { notificationsTable, userDevicesTable } from "../db/schema.js";

const expo = new Expo();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sanitizePayload = (data) => {
  if (!data || typeof data !== "object") return {};
  return data;
};

export const cleanupOldNotifications = async (days = 30) => {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  await db.delete(notificationsTable).where(lte(notificationsTable.createdAt, cutoff));
};

const saveNotification = async ({ userId, title, body, data }) => {
  await db.insert(notificationsTable).values({
    userId,
    title,
    body,
    data: sanitizePayload(data),
  });
};

const saveNotificationsForUsers = async ({ userIds, title, body, data }) => {
  if (!userIds.length) return;
  await db.insert(notificationsTable).values(
    userIds.map((userId) => ({
      userId,
      title,
      body,
      data: sanitizePayload(data),
    }))
  );
};

const fetchDeviceRows = async (userIds) => {
  if (!userIds.length) return [];
  return db
    .select({
      id: userDevicesTable.id,
      userId: userDevicesTable.userId,
      pushToken: userDevicesTable.pushToken,
      platform: userDevicesTable.platform,
    })
    .from(userDevicesTable)
    .where(inArray(userDevicesTable.userId, userIds));
};

const buildMessages = ({ deviceRows, title, body, data }) => {
  const payload = sanitizePayload(data);
  return deviceRows
    .filter((row) => Expo.isExpoPushToken(row.pushToken))
    .map((row) => ({
      to: row.pushToken,
      sound: "default",
      title,
      body,
      data: payload,
    }));
};

const removeInvalidTokens = async (tokens) => {
  const unique = [...new Set(tokens.filter(Boolean))];
  if (!unique.length) return;
  await db.delete(userDevicesTable).where(inArray(userDevicesTable.pushToken, unique));
};

const sendMessagesInChunks = async (messages) => {
  if (!messages.length) {
    return {
      sent: 0,
      invalidTokensRemoved: 0,
    };
  }

  const chunks = expo.chunkPushNotifications(messages);
  const ticketIdToToken = new Map();
  const ticketIds = [];

  await Promise.all(
    chunks.map(async (chunk) => {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      tickets.forEach((ticket, idx) => {
        const token = chunk[idx]?.to;
        if (ticket?.id && token) {
          ticketIds.push(ticket.id);
          ticketIdToToken.set(ticket.id, token);
        }
      });
    })
  );

  if (!ticketIds.length) {
    return {
      sent: messages.length,
      invalidTokensRemoved: 0,
    };
  }

  // Expo receipts can take a moment to be available.
  await sleep(1200);

  const receiptChunks = expo.chunkPushNotificationReceiptIds(ticketIds);
  const invalidTokens = [];

  await Promise.all(
    receiptChunks.map(async (chunk) => {
      const receipts = await expo.getPushNotificationReceiptsAsync(chunk);
      Object.entries(receipts).forEach(([ticketId, receipt]) => {
        if (receipt?.status === "error" && receipt?.details?.error === "DeviceNotRegistered") {
          const token = ticketIdToToken.get(ticketId);
          if (token) invalidTokens.push(token);
        }
      });
    })
  );

  await removeInvalidTokens(invalidTokens);

  return {
    sent: messages.length,
    invalidTokensRemoved: [...new Set(invalidTokens)].length,
  };
};

export const sendNotificationToUser = async ({
  userId,
  title,
  body,
  data = {},
}) => {
  await saveNotification({ userId, title, body, data });
  const deviceRows = await fetchDeviceRows([userId]);
  const messages = buildMessages({ deviceRows, title, body, data });
  return sendMessagesInChunks(messages);
};

// Many-to-many / bulk helper for scheduled reminders or campaign-style sends.
export const sendNotificationToUsers = async ({
  userIds,
  title,
  body,
  data = {},
}) => {
  const uniqueUserIds = [...new Set((userIds || []).filter(Boolean))];
  if (!uniqueUserIds.length) return { sent: 0, invalidTokensRemoved: 0 };

  await saveNotificationsForUsers({ userIds: uniqueUserIds, title, body, data });
  const deviceRows = await fetchDeviceRows(uniqueUserIds);
  const messages = buildMessages({ deviceRows, title, body, data });
  return sendMessagesInChunks(messages);
};

export const getUserNotificationHistory = async ({ userId, limit = 20 }) => {
  return db
    .select()
    .from(notificationsTable)
    .where(eq(notificationsTable.userId, userId))
    .orderBy(desc(notificationsTable.createdAt))
    .limit(limit);
};

export const markNotificationAsRead = async ({ id, userId }) => {
  await db
    .update(notificationsTable)
    .set({ isRead: true })
    .where(and(eq(notificationsTable.id, id), eq(notificationsTable.userId, userId)));
};
