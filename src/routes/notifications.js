// This route collects all the notifiocation message from the database
// It also check whether users has read the message or not

import express from "express";
import { attachUserFromAuth, ensureClerkIdMatch, requireClerkAuth } from "../middleware/auth.js";
import { getUserNotificationHistory, markNotificationAsRead } from "../services/notificationService.js";

const notificationRoutes = express.Router();

// GET /api/notifications/:clerkId
notificationRoutes.get(
  "/:clerkId",
  requireClerkAuth,
  ensureClerkIdMatch("params"),
  attachUserFromAuth,
  async (req, res) => {
    try {
      const items = await getUserNotificationHistory({
        userId: req.dbUser.userId,
        limit: 20,
      });
      return res.status(200).json(items);
    } catch (error) {
      console.error("Fetch notification history error:", error);
      return res.status(500).json({ error: "Failed to fetch notifications" });
    }
  }
);

// PATCH /api/notifications/:id/read
notificationRoutes.patch(
  "/:id/read",
  requireClerkAuth,
  attachUserFromAuth,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid notification id" });
      }

      await markNotificationAsRead({
        id,
        userId: req.dbUser.userId,
      });

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error("Mark notification read error:", error);
      return res.status(500).json({ error: "Failed to update notification" });
    }
  }
);

export default notificationRoutes;
