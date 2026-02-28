// Backend/utils/mailer.js
const nodemailer = require("nodemailer");

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return process.env[name];
}

function createTransport() {
  const host = requireEnv("SMTP_HOST");
  const port = Number(requireEnv("SMTP_PORT"));
  const user = requireEnv("SMTP_USER");
  const pass = requireEnv("SMTP_PASS");

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

async function sendMailWithAttachment({ to, subject, text, filename, content, contentType }) {
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;

  const transporter = createTransport();
  await transporter.sendMail({
    from,
    to,
    subject,
    text,
    attachments: [
      {
        filename,
        content,
        contentType: contentType || "application/octet-stream",
      },
    ],
  });
}

module.exports = { sendMailWithAttachment };