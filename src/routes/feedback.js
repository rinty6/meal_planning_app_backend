// This file handles user feedback submissions and sends them via email
import express from "express";
import nodemailer from "nodemailer";

const feedbackRoutes = express.Router();

// Configure email transporter
// You should add these to your .env file
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || '',
    pass: process.env.EMAIL_PASSWORD || ''
  }
});

// ENDPOINT: POST /api/feedback/submit
feedbackRoutes.post('/submit', async (req, res) => {
  try {
    const { clerkId, userEmail, feedbackText, imageBase64 } = req.body;

    // Validate required fields
    if (!feedbackText || feedbackText.trim() === '') {
      return res.status(400).json({ error: "Feedback text is required" });
    }

    if (!userEmail) {
      return res.status(400).json({ error: "User email is required" });
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
      from: process.env.EMAIL_USER || '',
      to: 'duongphuthinh2001@gmail.com',
      cc: userEmail, // Send a copy to the user
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
    const info = await transporter.sendMail(mailOptions);
    
    return res.status(200).json({ 
      success: true, 
      message: "Feedback sent successfully",
      messageId: info.messageId 
    });

  } catch (error) {
    console.error("Error sending feedback:", error);
    return res.status(500).json({ 
      error: "Failed to send feedback",
      details: error.message 
    });
  }
});

export default feedbackRoutes;
