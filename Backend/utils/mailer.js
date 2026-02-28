const nodemailer = require("nodemailer");

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || "true") === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function sendMailWithAttachment({ to, subject, text, filename, content }) {
  const transporter = createTransporter();
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;

  await transporter.sendMail({
    from,
    to,
    subject,
    text,
    attachments: [{ filename, content }]
  });
}

module.exports = { sendMailWithAttachment };