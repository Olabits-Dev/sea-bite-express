const nodemailer = require("nodemailer");

function boolEnv(v, fallback = false) {
  if (v === undefined || v === null || v === "") return fallback;
  return String(v).toLowerCase() === "true";
}

function createTransporter() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = boolEnv(process.env.SMTP_SECURE, true);

  if (!host) throw new Error("SMTP_HOST is not set");
  if (!process.env.SMTP_USER) throw new Error("SMTP_USER is not set");
  if (!process.env.SMTP_PASS) throw new Error("SMTP_PASS is not set");

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000
  });
}

async function sendMailWithAttachment({ to, subject, text, filename, content }) {
  const transporter = createTransporter();
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;

  try {
    await transporter.sendMail({
      from,
      to,
      subject,
      text,
      attachments: [{ filename, content }]
    });
  } catch (err) {
    const msg = err?.response
      ? `${err.message} | SMTP: ${err.response}`
      : (err?.message || "Failed to send email");
    throw new Error(msg);
  }
}

module.exports = { sendMailWithAttachment };