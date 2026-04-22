// This routes handles the token notification across muptiple devices
// A user can be sent a message although they use moblie, ipad,..

import express from "express";
import { db } from "../config/db.js";
import { userDevicesTable } from "../db/schema.js";
import { attachUserFromAuth, ensureClerkIdMatch, requireClerkAuth } from "../middleware/auth.js";

const deviceRoutes = express.Router();

const normalizePlatform = (platform) => {
  const value = String(platform || "").toLowerCase();
  if (value === "ios" || value === "android") return value;
  return "unknown";
};

deviceRoutes.post(
  "/register",
  requireClerkAuth,
  ensureClerkIdMatch("body"),
  attachUserFromAuth,
  async (req, res) => {
    try {
      const { pushToken, platform, clerkId } = req.body;

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

      return res.status(200).json({ success: true, message: "Device registered" });
    } catch (error) {
      console.error("Device registration error:", error);
      return res.status(500).json({ error: "Failed to register device" });
    }
  }
);

export default deviceRoutes;
