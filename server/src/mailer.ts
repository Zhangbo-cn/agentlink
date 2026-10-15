import nodemailer from "nodemailer";
import type { Config } from "./config.ts";
import type { Logger } from "./util.ts";

export interface Mailer {
  send(to: string, subject: string, text: string, html?: string): Promise<void>;
  verify?(): Promise<void>;
  readonly kind: string;
}

/**
 * SMTP presets for common providers. All of them require an "authorization code" /
 * app password rather than the normal login password, and all of them reject mail whose
 * From address differs from the authenticated account.
 */
export const SMTP_PRESETS: Record<string, { host: string; port: number; secure: boolean; note: string }> = {
  qq: { host: "smtp.qq.com", port: 465, secure: true, note: "QQ邮箱: 设置 → 账号 → 开启 POP3/SMTP 服务，生成授权码作为密码" },
  exmail: { host: "smtp.exmail.qq.com", port: 465, secure: true, note: "腾讯企业邮: 使用客户端专用密码" },
  "163": { host: "smtp.163.com", port: 465, secure: true, note: "网易163: 设置 → POP3/SMTP/IMAP → 开启 SMTP，使用授权码" },
  "126": { host: "smtp.126.com", port: 465, secure: true, note: "网易126: 同 163，使用授权码" },
  yeah: { host: "smtp.yeah.net", port: 465, secure: true, note: "网易 yeah.net: 使用授权码" },
  "163qiye": { host: "smtphz.qiye.163.com", port: 465, secure: true, note: "网易企业邮: 使用客户端授权码" },
  aliyun: { host: "smtp.aliyun.com", port: 465, secure: true, note: "阿里邮箱个人版" },
  gmail: { host: "smtp.gmail.com", port: 465, secure: true, note: "Gmail: 开启两步验证后生成 App Password (16 位)" },
  outlook: { host: "smtp.office365.com", port: 587, secure: false, note: "Outlook/Microsoft 365: 需租户允许 SMTP AUTH；个人 outlook.com 已逐步关闭基本认证" },
  sendgrid: { host: "smtp.sendgrid.net", port: 465, secure: true, note: "SendGrid: 用户名为 apikey，密码为 API Key" },
  ses: { host: "email-smtp.us-east-1.amazonaws.com", port: 465, secure: true, note: "Amazon SES: 用 SMTP 凭证，按区域替换主机" },
};

export type SmtpSettings = { url?: string; provider?: string; user?: string; pass?: string; host?: string; port?: number; secure?: boolean; from?: string; insecureTls?: boolean };

/** Build nodemailer options + a From address that the provider will accept. */
export function resolveSmtp(s: SmtpSettings): { transport: any; from: string; label: string } | null {
  const fromName = "AgentLink";
  if (s.url) {
    const u = new URL(s.url);
    const user = decodeURIComponent(u.username);
    return { transport: s.url, from: s.from || (user.includes("@") ? `${fromName} <${user}>` : `${fromName} <no-reply@${u.hostname}>`), label: u.hostname };
  }
  const preset = s.provider ? SMTP_PRESETS[s.provider.toLowerCase()] : undefined;
  if (s.provider && !preset && !s.host) throw new Error(`Unknown AGENTLINK_SMTP_PROVIDER "${s.provider}". Known: ${Object.keys(SMTP_PRESETS).join(", ")}`);
  const host = s.host || preset?.host;
  if (!host) return null;
  if (!s.user || !s.pass) throw new Error("AGENTLINK_SMTP_USER and AGENTLINK_SMTP_PASS are required with AGENTLINK_SMTP_PROVIDER / AGENTLINK_SMTP_HOST");
  const port = s.port || preset?.port || 465;
  const secure = s.secure ?? preset?.secure ?? port === 465;
  return {
    transport: { host, port, secure, requireTLS: !secure, auth: { user: s.user, pass: s.pass }, ...(s.insecureTls ? { tls: { rejectUnauthorized: false } } : {}), connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000 },
    // QQ / 163 / Gmail reject a From that is not the authenticated mailbox.
    from: s.from || `${fromName} <${s.user}>`,
    label: `${s.provider ?? host}`,
  };
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
  constructor(transport: any, private from: string) {
    this.transport = nodemailer.createTransport(transport);
  }
  async send(to: string, subject: string, text: string, html?: string): Promise<void> {
    await this.transport.sendMail({ from: this.from, to, subject, text, ...(html ? { html } : {}) });
  }
  async verify(): Promise<void> {
    await this.transport.verify();
  }
}

export function smtpSettingsFromConfig(cfg: Config): SmtpSettings {
  return { url: cfg.smtpUrl || undefined, provider: cfg.smtp.provider, user: cfg.smtp.user, pass: cfg.smtp.pass, host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.secure, insecureTls: cfg.smtp.insecureTls, from: cfg.mailFrom || undefined };
}

export function createMailer(cfg: Config, log: Logger): Mailer {
  const r = resolveSmtp(smtpSettingsFromConfig(cfg));
  if (!r) return new LogMailer(log);
  log.info("mail.smtp", { via: r.label, from: r.from });
  return new SmtpMailer(r.transport, r.from);
}

/** Map raw SMTP errors to actionable hints (logged for the operator, never shown to end users). */
export function explainSmtpError(err: unknown): string {
  const m = String((err as Error)?.message ?? err);
  if (/User has no permission/i.test(m)) return `${m} — 该邮箱尚未开启 SMTP 服务：网易邮箱请到 设置 → POP3/SMTP/IMAP 开启"IMAP/SMTP服务"，并用开启时生成的授权码作为 AGENTLINK_SMTP_PASS`;
  if (/must be same as authorization user|sender address rejected|not owned by user|553|501/i.test(m)) return `${m} — 发件人(AGENTLINK_MAIL_FROM)必须与 SMTP 登录账号一致；留空即可自动使用登录账号`;
  if (/535|auth|invalid login|username and password not accepted|BadCredentials/i.test(m)) return `${m} — 认证失败：QQ/163/126 需使用"授权码"，Gmail 需使用 App Password，而不是登录密码`;
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|Greeting never received|timeout/i.test(m)) return `${m} — 无法连接 SMTP 服务器：检查网络/防火墙（很多云厂商封禁出站 25 端口，请用 465/587）；国内服务器连 Gmail 通常不可达`;
  if (/550|spam|blocked|rejected/i.test(m)) return `${m} — 被收件方拒收：检查发件域名的 SPF/DKIM，或改用专业发信服务`;
  return m;
}

export function loginEmail(code: string, cfg: Config): { subject: string; text: string; html: string } {
  const text = [
    `Your AgentLink sign-in code is: ${code}`,
    `您的 AgentLink 登录验证码是：${code}`,
    "",
    "Enter it where you started signing in. It expires in 10 minutes.",
    "请在发起登录的终端中输入，10 分钟内有效。",
    `Server: ${cfg.publicUrl}`,
    "",
    "If you did not request this, ignore this email. 如果不是您本人操作，请忽略本邮件。",
  ].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px">
<p>Your AgentLink sign-in code / 您的 AgentLink 登录验证码：</p>
<p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>
<p>Expires in 10 minutes. 10 分钟内有效。<br>Server: ${cfg.publicUrl}</p>
<p style="color:#888">If you did not request this, ignore this email. 如果不是您本人操作，请忽略本邮件。</p></div>`;
  return { subject: `AgentLink 验证码 ${code} / sign-in code`, text, html };
}
