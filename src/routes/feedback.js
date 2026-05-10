// This file handles user feedback submissions and sends them via email
import express from "express";
import dns from "node:dns/promises";
import nodemailer from "nodemailer";
import { Resend } from "resend";
import { ENV } from "../config/env.js";

const feedbackRoutes = express.Router();
const FEEDBACK_SMTP_HOST = "smtp.gmail.com";
const FEEDBACK_SMTP_PORT = 465;
const FEEDBACK_SMTP_CONNECTION_TIMEOUT_MS = 8_000;
const FEEDBACK_SMTP_GREETING_TIMEOUT_MS = 8_000;
const FEEDBACK_SMTP_SOCKET_TIMEOUT_MS = 15_000;
const FEEDBACK_PROVIDER_RESEND = "resend";
const FEEDBACK_PROVIDER_SMTP = "smtp";

// Normalize feedback mail settings so configuration failures are explicit.
const getFeedbackMailConfig = () => ({
  sender: ENV.EMAIL_USER.trim(),
  password: ENV.EMAIL_PASSWORD.trim(),
  recipient: ENV.FEEDBACK_TO_EMAIL.trim(),
  resendApiKey: ENV.RESEND_API_KEY.trim(),
  fromEmail: ENV.FEEDBACK_FROM_EMAIL.trim(),
});

const getFeedbackProvider = (config) => {
  if (config.resendApiKey) {
    return FEEDBACK_PROVIDER_RESEND;
  }

  return FEEDBACK_PROVIDER_SMTP;
};

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

const buildFeedbackMailPayload = ({ clerkId, userEmail, feedbackText, imageBase64 }) => {
  // Build one normalized payload so SMTP and HTTPS providers send the same content.
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

  const attachments = [];
  if (imageBase64) {
    const base64Data = imageBase64.split(',')[1] || imageBase64;
    attachments.push({
      filename: `feedback-${Date.now()}.jpg`,
      content: base64Data,
      contentType: 'image/jpeg',
    });
  }

  return {
    emailContent,
    attachments,
    subject: `New Feedback from ${userEmail}`,
  };
};

const sendFeedbackByResend = async ({ mailConfig, userEmail, payload }) => {
  if (!mailConfig.fromEmail) {
    return {
      ok: false,
      status: 503,
      code: "FEEDBACK_EMAIL_NOT_CONFIGURED",
      error: "Feedback email service is missing FEEDBACK_FROM_EMAIL for Resend.",
    };
  }

  const resend = new Resend(mailConfig.resendApiKey);
  const { data, error } = await resend.emails.send({
    from: mailConfig.fromEmail,
    to: [mailConfig.recipient],
    cc: [userEmail],
    replyTo: [userEmail],
    subject: payload.subject,
    html: payload.emailContent,
    attachments: payload.attachments,
  });

  if (error) {
    return {
      ok: false,
      status: 503,
      code: "FEEDBACK_EMAIL_API_FAILED",
      error: error.message || "Feedback email service rejected the message.",
    };
  }

  return {
    ok: true,
    status: 200,
    messageId: data?.id || null,
  };
};

const sendFeedbackBySmtp = async ({ mailConfig, userEmail, payload }) => {
  const transporter = await createFeedbackTransporter(mailConfig);
  const info = await transporter.sendMail({
    from: mailConfig.sender,
    to: mailConfig.recipient,
    cc: userEmail,
    replyTo: userEmail,
    subject: payload.subject,
    html: payload.emailContent,
    attachments: payload.attachments.map((attachment) => ({
      ...attachment,
      content: Buffer.from(attachment.content, 'base64'),
    })),
  });

  return {
    ok: true,
    status: 200,
    messageId: info.messageId,
  };
};

// ENDPOINT: POST /api/feedback/submit
feedbackRoutes.post('/submit', async (req, res) => {
  try {
    const { clerkId, userEmail, feedbackText, imageBase64 } = req.body;
    const mailConfig = getFeedbackMailConfig();
    const feedbackProvider = getFeedbackProvider(mailConfig);

    // Validate required fields
    if (!feedbackText || feedbackText.trim() === '') {
      return res.status(400).json({ error: "Feedback text is required" });
    }

    if (!userEmail) {
      return res.status(400).json({ error: "User email is required" });
    }

    if (!mailConfig.recipient) {
      return res.status(503).json({
        error: "Feedback email service is not configured.",
        code: "FEEDBACK_EMAIL_NOT_CONFIGURED",
      });
    }

    if (
      feedbackProvider === FEEDBACK_PROVIDER_SMTP &&
      (!mailConfig.sender || !mailConfig.password)
    ) {
      return res.status(503).json({
        error: "Feedback email service is not configured.",
        code: "FEEDBACK_EMAIL_NOT_CONFIGURED",
      });
    }

    const payload = buildFeedbackMailPayload({
      clerkId,
      userEmail,
      feedbackText,
      imageBase64,
    });
    const sendResult =
      feedbackProvider === FEEDBACK_PROVIDER_RESEND
        ? await sendFeedbackByResend({ mailConfig, userEmail, payload })
        : await sendFeedbackBySmtp({ mailConfig, userEmail, payload });

    if (!sendResult.ok) {
      return res.status(sendResult.status || 503).json({
        error: sendResult.error || "Failed to send feedback",
        code: sendResult.code || "FEEDBACK_SEND_FAILED",
      });
    }
    
    return res.status(200).json({ 
      success: true, 
      message: "Feedback sent successfully",
      messageId: sendResult.messageId,
      provider: feedbackProvider,
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
        error: "Feedback email service timed out while connecting from the backend. On Railway, switch feedback delivery to an HTTPS email API such as Resend instead of SMTP.",
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

      if (error?.name === 'validation_error' || error?.statusCode === 422) {
        return res.status(503).json({
          error: "Feedback email API rejected the request. Verify FEEDBACK_FROM_EMAIL is a valid sender for the configured provider.",
          code: "FEEDBACK_EMAIL_API_INVALID",
        });
      }

    return res.status(500).json({ 
      error: "Failed to send feedback",
      code: "FEEDBACK_SEND_FAILED",
    });
  }
});

export default feedbackRoutes;
