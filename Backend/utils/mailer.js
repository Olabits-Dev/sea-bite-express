// Backend/utils/mailer.js
require("dotenv").config();

// ✅ Force IPv4 first (fix ENETUNREACH to IPv6 SMTP hosts)
const dns = require("dns");
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder("ipv4first");
}

const nodemailer = require("nodemailer");

const EMAIL_HOST = process.env.EMAIL_HOST;
const EMAIL_PORT = Number(process.env.EMAIL_PORT || 587);
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_FROM = process.env.EMAIL_FROM || EMAIL_USER;

function assertMailEnv() {
  const missing = [];
  if (!EMAIL_HOST) missing.push("EMAIL_HOST");
  if (!EMAIL_USER) missing.push("EMAIL_USER");
  if (!EMAIL_PASS) missing.push("EMAIL_PASS");
  if (!EMAIL_FROM) missing.push("EMAIL_FROM");

  if (missing.length) {
    const err = new Error(`Email not configured. Missing: ${missing.join(", ")}`);
    err.code = "MAIL_CONFIG_MISSING";
    throw err;
  }
}

function createTransport() {
  assertMailEnv();

  return nodemailer.createTransport({
    host: EMAIL_HOST,
    port: EMAIL_PORT,
    secure: EMAIL_PORT === 465, // true for 465, false for 587
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    // helpful timeouts (avoid hanging requests)
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000
  });
}

async function sendMailWithAttachment({ to, subject, text, filename, content, contentType }) {
  const transporter = createTransport();

  try {
    const info = await transporter.sendMail({
      from: EMAIL_FROM,
      to,
      subject,
      text,
      attachments: [
        {
          filename,
          content,
          contentType: contentType || "text/plain"
        }
      ]
    });

    return { ok: true, messageId: info.messageId || null };
  } catch (e) {
    // Return useful debug info to frontend
    const err = new Error(e.message || "Email send failed");
    err.code = e.code || "MAIL_SEND_FAILED";
    err.details = {
      code: e.code,
      errno: e.errno,
      syscall: e.syscall,
      address: e.address,
      port: e.port,
      command: e.command,
      response: e.response
    };
    throw err;
  }
}

module.exports = { sendMailWithAttachment };