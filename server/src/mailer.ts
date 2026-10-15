import nodemailer from "nodemailer";
import type { Config } from "./config.ts";
import type { Logger } from "./util.ts";

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
  readonly kind: string;
}

/** Development fallback: writes the mail to the server log instead of sending it. */
export class LogMailer implements Mailer {
  readonly kind = "log";
  constructor(private log: Logger) {}
  async send(to: string, subject: string, text: string): Promise<void> {
    this.log.warn("mail.not_sent (no SMTP configured)", { to, subject, text });
  }
}

export class SmtpMailer implements Mailer {
  readonly kind = "smtp";
  private transport: nodemailer.Transporter;
  constructor(url: string, private from: string) {
    this.transport = nodemailer.createTransport(url);
  }
  async send(to: string, subject: string, text: string): Promise<void> {
    await this.transport.sendMail({ from: this.from, to, subject, text });
  }
}

export function createMailer(cfg: Config, log: Logger): Mailer {
  return cfg.smtpUrl ? new SmtpMailer(cfg.smtpUrl, cfg.mailFrom) : new LogMailer(log);
}

export function loginEmail(code: string, cfg: Config): { subject: string; text: string } {
  return {
    subject: `${code} is your AgentLink sign-in code`,
    text: [
      `Your AgentLink sign-in code is: ${code}`,
      "",
      "Enter it in the terminal where you started signing in. It expires in 10 minutes.",
      `Server: ${cfg.publicUrl}`,
      "",
      "If you did not request this, you can ignore this email.",
    ].join("\n"),
  };
}
