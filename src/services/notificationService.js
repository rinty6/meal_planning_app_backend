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

const redactPushToken = (token) => {
  const value = String(token || "");
  if (value.length <= 16) return value ? "[redacted]" : null;
  return `${value.slice(0, 12)}...[redacted]...${value.slice(-6)}`;
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

const getInvalidFormatTokenCount = (deviceRows) => {
  return deviceRows.filter((row) => !Expo.isExpoPushToken(row.pushToken)).length;
};

const removeInvalidTokens = async (tokens) => {
  const unique = [...new Set(tokens.filter(Boolean))];
  if (!unique.length) return;
  await db.delete(userDevicesTable).where(inArray(userDevicesTable.pushToken, unique));
  console.warn("[notificationService] Removed invalid Expo push tokens", {
    count: unique.length,
  });
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
  const invalidTokens = [];
  const ticketErrors = [];

  await Promise.all(
    chunks.map(async (chunk) => {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      tickets.forEach((ticket, idx) => {
        const token = chunk[idx]?.to;
        if (ticket?.status === "error") {
          const errorCode = ticket?.details?.error || "UnknownExpoTicketError";
          if (errorCode === "DeviceNotRegistered" && token) {
            invalidTokens.push(token);
          } else {
            ticketErrors.push({
              token: redactPushToken(token),
              errorCode,
              message: ticket?.message || null,
            });
          }
          return;
        }

        if (ticket?.id && token) {
          ticketIds.push(ticket.id);
          ticketIdToToken.set(ticket.id, token);
        }
      });
    })
  );

  if (ticketErrors.length) {
    console.warn("[notificationService] Expo push ticket errors", {
      count: ticketErrors.length,
      errors: ticketErrors,
    });
  }

  if (!ticketIds.length) {
    await removeInvalidTokens(invalidTokens);
    return {
      sent: Math.max(0, messages.length - invalidTokens.length),
      invalidTokensRemoved: [...new Set(invalidTokens)].length,
    };
  }

  // Expo receipts can take a moment to be available.
  await sleep(1200);

  const receiptChunks = expo.chunkPushNotificationReceiptIds(ticketIds);
  const receiptErrors = [];

  await Promise.all(
    receiptChunks.map(async (chunk) => {
      const receipts = await expo.getPushNotificationReceiptsAsync(chunk);
      Object.entries(receipts).forEach(([ticketId, receipt]) => {
        if (receipt?.status === "error") {
          const token = ticketIdToToken.get(ticketId);
          const errorCode = receipt?.details?.error || "UnknownExpoReceiptError";
          if (errorCode === "DeviceNotRegistered") {
            if (token) invalidTokens.push(token);
          } else {
            receiptErrors.push({
              token: redactPushToken(token),
              errorCode,
              message: receipt?.message || null,
            });
          }
        }
      });
    })
  );

  if (receiptErrors.length) {
    console.warn("[notificationService] Expo push receipt errors", {
      count: receiptErrors.length,
      errors: receiptErrors,
    });
  }

  await removeInvalidTokens(invalidTokens);

  return {
    sent: Math.max(0, messages.length - invalidTokens.length),
    invalidTokensRemoved: [...new Set(invalidTokens)].length,
  };
};

const logDeviceCoverage = ({ scope, userIds, deviceRows, messages }) => {
  const invalidFormatCount = getInvalidFormatTokenCount(deviceRows);
  if (!deviceRows.length || !messages.length || invalidFormatCount > 0) {
    console.warn("[notificationService] Push device coverage", {
      scope,
      userCount: userIds.length,
      deviceCount: deviceRows.length,
      validExpoTokenCount: messages.length,
      invalidFormatCount,
    });
  }
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
  logDeviceCoverage({ scope: "single_user", userIds: [userId], deviceRows, messages });
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
  logDeviceCoverage({ scope: "bulk_users", userIds: uniqueUserIds, deviceRows, messages });
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
