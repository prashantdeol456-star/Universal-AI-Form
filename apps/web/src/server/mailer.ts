import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { env, isProduction } from "./env";

let transporter: Transporter | undefined;

function getTransporter(): Transporter | null {
  const e = env();
  if (!e.SMTP_HOST) return null;
  transporter ??= nodemailer.createTransport({
    host: e.SMTP_HOST,
    port: e.SMTP_PORT,
    secure: e.SMTP_SECURE,
    auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASSWORD } : undefined,
  });
  return transporter;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Sends an email via SMTP (Hostinger mail, any SMTP provider, or Mailpit locally).
 * Without SMTP in development, the message is printed to the server console so
 * flows remain testable. In production a missing SMTP config is an error.
 */
export async function sendMail(mail: Mail): Promise<void> {
  const t = getTransporter();
  if (!t) {
    if (isProduction()) throw new Error("SMTP is not configured");
    console.info(`[mail:dev] to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
    return;
  }
  // Header values may contain user-supplied text (e.g. a café name): never let CR/LF through.
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const subject = mail.subject.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 200);
  await t.sendMail({ from: env().MAIL_FROM, to: mail.to, subject, text: mail.text });
}
