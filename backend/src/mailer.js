// Minimal SMTP mailer used only for the staff "забыли пароль" reminder (see
// POST /api/staff/forgot-password in index.js). Deliberately provider-agnostic
// plain SMTP — no specific mailbox is assumed, fill SMTP_* in .env.example
// for whatever the agency wants to send from.

const nodemailer = require('nodemailer');
const config = require('./config');

let transporter = null;

function getTransporter() {
  if (!config.smtpHost || !config.smtpUser || !config.smtpPassword) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: { user: config.smtpUser, pass: config.smtpPassword },
    });
  }
  return transporter;
}

function isConfigured() {
  return !!getTransporter();
}

async function sendMail({ to, subject, text }) {
  const t = getTransporter();
  if (!t) {
    throw new Error('SMTP is not configured (SMTP_HOST/SMTP_USER/SMTP_PASSWORD) — see .env.example.');
  }
  await t.sendMail({ from: config.smtpFrom || config.smtpUser, to, subject, text });
}

module.exports = { isConfigured, sendMail };
