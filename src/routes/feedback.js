// This file handles user feedback submissions and sends them via email
import express from "express";
import dns from "node:dns/promises";
import nodemailer from "nodemailer";
import { ENV } from "../config/env.js";

const feedbackRoutes = express.Router();
const FEEDBACK_SMTP_HOST = "smtp.gmail.com";
const FEEDBACK_SMTP_PORT = 465;
const FEEDBACK_SMTP_CONNECTION_TIMEOUT_MS = 8_000;
const FEEDBACK_SMTP_GREETING_TIMEOUT_MS = 8_000;
const FEEDBACK_SMTP_SOCKET_TIMEOUT_MS = 15_000;

// Normalize feedback mail settings so configuration failures are explicit.
const getFeedbackMailConfig = () => ({
  sender: ENV.EMAIL_USER.trim(),
  password: ENV.EMAIL_PASSWORD.trim(),
  recipient: ENV.FEEDBACK_TO_EMAIL.trim(),
});

const resolveFeedbackSmtpHost = async () => {
  try {
    const addresses = await dns.resolve4(FEEDBACK_SMTP_HOST);
    return addresses[0] || FEEDBACK_SMTP_HOST;
  } catch {
    return FEEDBACK_SMTP_HOST;
  }
};

// Resolve Gmail to IPv4 first so Railway does not get stuck on unreachable IPv6 SMTP addresses.
const createFeedbackTransporter = async ({ sender, password }) => {
  const resolvedHost = await resolveFeedbackSmtpHost();

  return nodemailer.createTransport({
    host: resolvedHost,
    port: FEEDBACK_SMTP_PORT,
    secure: true,
    auth: {
      user: sender,
      pass: password,
    },
    connectionTimeout: FEEDBACK_SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: FEEDBACK_SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: FEEDBACK_SMTP_SOCKET_TIMEOUT_MS,
    dnsTimeout: 5_000,
    tls: {
      servername: FEEDBACK_SMTP_HOST,
    },
  });
};

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
    const transporter = await createFeedbackTransporter(mailConfig);
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

    if (error?.code === 'ETIMEDOUT') {
      return res.status(503).json({
        error: "Feedback email service timed out while connecting to Gmail from the backend. Please try again later.",
        code: "FEEDBACK_EMAIL_TIMEOUT",
      });
    }

    if (
      error?.code === 'ESOCKET' ||
      error?.code === 'ENETUNREACH' ||
      error?.code === 'ECONNECTION'
    ) {
      return res.status(503).json({
        error: "Feedback email service is unreachable from the backend right now. Please try again later.",
        code: "FEEDBACK_EMAIL_CONNECTION_FAILED",
      });
    }

    return res.status(500).json({ 
      error: "Failed to send feedback",
      code: "FEEDBACK_SEND_FAILED",
    });
  }
});

export default feedbackRoutes;
