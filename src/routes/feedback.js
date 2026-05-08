// This file handles user feedback submissions and sends them via email
import express from "express";
import nodemailer from "nodemailer";
import { ENV } from "../config/env.js";

const feedbackRoutes = express.Router();

// Normalize feedback mail settings so configuration failures are explicit.
const getFeedbackMailConfig = () => ({
  sender: ENV.EMAIL_USER.trim(),
  password: ENV.EMAIL_PASSWORD.trim(),
  recipient: ENV.FEEDBACK_TO_EMAIL.trim(),
});

// Create the transporter from current env-backed settings for each send attempt.
const createFeedbackTransporter = ({ sender, password }) => nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: sender,
    pass: password,
  },
});

// ENDPOINT: POST /api/feedback/submit
feedbackRoutes.post('/submit', async (req, res) => {
  try {
    const { clerkId, userEmail, feedbackText, imageBase64 } = req.body;
    const mailConfig = getFeedbackMailConfig();

    // Validate required fields
    if (!feedbackText || feedbackText.trim() === '') {
      return res.status(400).json({ error: "Feedback text is required" });
    }

    if (!userEmail) {
      return res.status(400).json({ error: "User email is required" });
    }

    if (!mailConfig.sender || !mailConfig.password || !mailConfig.recipient) {
      return res.status(503).json({
        error: "Feedback email service is not configured.",
        code: "FEEDBACK_EMAIL_NOT_CONFIGURED",
      });
    }

    // Prepare email content
    const emailContent = `
      <h2>New Feedback Submission</h2>
      <p><strong>From User:</strong> ${userEmail}</p>
      <p><strong>Clerk ID:</strong> ${clerkId || 'N/A'}</p>
      <hr />
      <h3>Feedback:</h3>
      <p>${feedbackText.replace(/\n/g, '<br>')}</p>
      <hr />
      <p><em>Submitted at: ${new Date().toLocaleString()}</em></p>
    `;

    // Prepare email options
    const mailOptions = {
      from: mailConfig.sender,
      to: mailConfig.recipient,
      cc: userEmail, // Send a copy to the user
      replyTo: userEmail,
      subject: `New Feedback from ${userEmail}`,
      html: emailContent,
    };

    // Add image as attachment if provided
    if (imageBase64) {
      const base64Data = imageBase64.split(',')[1] || imageBase64;
      mailOptions.attachments = [
        {
          filename: `feedback-${Date.now()}.jpg`,
          content: Buffer.from(base64Data, 'base64'),
          contentType: 'image/jpeg'
        }
      ];
    }

    // Send email
    const transporter = createFeedbackTransporter(mailConfig);
    const info = await transporter.sendMail(mailOptions);
    
    return res.status(200).json({ 
      success: true, 
      message: "Feedback sent successfully",
      messageId: info.messageId 
    });

  } catch (error) {
    console.error("Error sending feedback:", error);

    if (error?.code === 'EAUTH' || error?.responseCode === 535) {
      return res.status(503).json({
        error: "Feedback email login was rejected by Gmail. Update EMAIL_USER and EMAIL_PASSWORD with a valid Gmail app password.",
        code: "FEEDBACK_EMAIL_AUTH_FAILED",
      });
    }

    return res.status(500).json({ 
      error: "Failed to send feedback",
      code: "FEEDBACK_SEND_FAILED",
    });
  }
});

export default feedbackRoutes;
