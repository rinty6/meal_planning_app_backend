// This routes handles the token notification across muptiple devices
// A user can be sent a message although they use moblie, ipad,..

import express from "express";
import { eq } from "drizzle-orm";
import { db } from "../config/db.js";
import { userDevicesTable, usersTable } from "../db/schema.js";
import { attachUserFromAuth, ensureClerkIdMatch, requireClerkAuth } from "../middleware/auth.js";

const deviceRoutes = express.Router();

const normalizePlatform = (platform) => {
  const value = String(platform || "").toLowerCase();
  if (value === "ios" || value === "android") return value;
  return "unknown";
};

// Accept an IANA timezone only if it is a real zone Intl can resolve.
// Anything invalid (or absent) returns null so we keep the existing value.
const normalizeTimeZone = (timezone) => {
  const value = String(timezone || "").trim();
  if (!value) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
};

deviceRoutes.post(
  "/register",
  requireClerkAuth,
  ensureClerkIdMatch("body"),
  attachUserFromAuth,
  async (req, res) => {
    try {
      const { pushToken, platform, clerkId, timezone } = req.body;

      if (!clerkId || !pushToken) {
        return res.status(400).json({ error: "Missing clerkId or pushToken" });
      }

      await db
        .insert(userDevicesTable)
        .values({
          userId: req.dbUser.userId,
          pushToken: String(pushToken).trim(),
          platform: normalizePlatform(platform),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: userDevicesTable.pushToken,
          set: {
            userId: req.dbUser.userId,
            platform: normalizePlatform(platform),
            updatedAt: new Date(),
          },
        });

      // Keep the user's timezone fresh from their device so the dispatcher can
      // send at their local time. Only write a valid IANA zone.
      const normalizedTimeZone = normalizeTimeZone(timezone);
      if (normalizedTimeZone) {
        await db
          .update(usersTable)
          .set({ timezone: normalizedTimeZone })
          .where(eq(usersTable.userId, req.dbUser.userId));
      }

      return res.status(200).json({ success: true, message: "Device registered" });
    } catch (error) {
      console.error("Device registration error:", error);
      return res.status(500).json({ error: "Failed to register device" });
    }
  }
);

export default deviceRoutes;
