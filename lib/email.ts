import { Resend } from "resend";
import nodemailer from "nodemailer";
import { getSetting } from "./settings";
export { renderNotificationEmail, emailTitle } from "./email-template";
export type { NotifyItem, RenderedEmail, EmailLocale } from "./email-template";
import type { EmailLocale } from "./email-template";

let resendClient: Resend | null = null;

export async function getEmailConfig() {
  const enabled = (await getSetting("notifications_enabled", "false")) === "true";
  const recipients = await getSetting("notification_recipients", "");
  const daysStr = await getSetting("notification_days", "3,7,21") || "3,7,21";
  const days = daysStr.split(",").map(d => parseInt(d.trim())).filter(Boolean);
  const provider = await getSetting("email_provider", "resend"); // "resend" | "smtp"

  const from = await getSetting("email_from", "AR <noreply@admin-redminer.local>") || "AR <noreply@admin-redminer.local>";
  const resendKey = await getSetting("resend_api_key", "");
  const smtpHost = await getSetting("smtp_host", "");
  const smtpPort = parseInt(await getSetting("smtp_port", "587") || "587");
  const smtpUser = await getSetting("smtp_user", "");
  const smtpPass = await getSetting("smtp_pass", "");
  // Recipients are addresses, not accounts, so they carry no language of their
  // own; one setting decides for the whole instance.
  const rawLocale = await getSetting("notification_locale", "pl");
  const locale: EmailLocale = rawLocale === "en" ? "en" : "pl";

  return {
    enabled,
    recipients: (recipients || "").split(",").map((e: string) => e.trim()).filter(Boolean),
    days,
    provider,
    from,
    resendKey,
    smtp: { host: smtpHost, port: smtpPort, user: smtpUser, pass: smtpPass },
    locale,
  };
}

export async function sendEmail(
  to: string[],
  subject: string,
  html: string,
  // Clients that refuse HTML show this instead of a blank message, and mail
  // filters treat html-only messages with suspicion.
  text?: string
): Promise<{ success: boolean; error?: string; id?: string; reason?: string }> {
  const config = await getEmailConfig();

  if (!config.enabled || to.length === 0) {
    console.log("Email notifications disabled or no recipients");
    return { success: false, reason: "disabled" };
  }

  try {
    if (config.provider === "resend" && config.resendKey) {
      if (!resendClient) {
        resendClient = new Resend(config.resendKey);
      }
      const { data, error } = await resendClient.emails.send({
        from: config.from,
        to,
        subject,
        html,
        ...(text ? { text } : {}),
      });
      if (error) throw error;
      return { success: true, id: data?.id };
    } else if (config.provider === "smtp" && config.smtp.host) {
      const transporter = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.port === 465,
        auth: config.smtp.user ? {
          user: config.smtp.user,
          pass: config.smtp.pass,
        } : undefined,
      });

      await transporter.sendMail({
        from: config.from,
        to: to.join(","),
        subject,
        html,
        ...(text ? { text } : {}),
      });
      return { success: true };
    } else {
      throw new Error("No email provider configured (Resend API key or SMTP settings)");
    }
  } catch (err: any) {
    console.error("Email send failed:", err);
    return { success: false, error: err.message };
  }
}


