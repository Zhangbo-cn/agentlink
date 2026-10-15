import path from "node:path";

/** Fair-use limits. 0 means unlimited. Applied to every account. */
export type Quotas = {
  monthlyMessages: number;
  maxDevices: number;
  maxOnlineAgents: number;
  maxAttachmentBytes: number;
  /** How long a message waits for an offline persistent agent. */
  queueTtlSec: number;
};

export type SignupMode = "email" | "invite" | "open";

export type Config = {
  host: string;
  port: number;
  dataDir: string;
  publicUrl: string;
  adminToken: string;
  metricsToken: string;
  /** email: anyone with a verified email can create an account. invite: admin/enrollment codes only. open: no verification (dev/LAN only). */
  signup: SignupMode;
  /** Optional allowlist of email domains for signup, e.g. ["example.com"]. Empty = any. */
  emailDomains: string[];
  smtpUrl: string;
  mailFrom: string;
  trustProxy: boolean;
  /** public: https + no private IPs (default). private: allow LAN/loopback targets (self-hosted intranets). off: disabled. */
  webhooks: "public" | "private" | "off";
  logLevel: "debug" | "info" | "warn" | "error" | "silent";
  quotas: Quotas;
  limits: {
    maxTextBytes: number;
    maxAttachmentsPerMessage: number;
    maxFrameBytes: number;
    ephemeralGraceSec: number;
    helloTimeoutMs: number;
    idleTimeoutMs: number;
    httpBurst: number;
    httpPerSec: number;
    wsSendBurst: number;
    wsSendPerSec: number;
    helloBurst: number;
    helloPerSec: number;
    emailPerIpPerHour: number;
    pollOnlineMs: number;
    redeliverAfterMs: number;
  };
};

const num = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const port = num(env.PORT, 8787);
  const signup = (env.AGENTLINK_SIGNUP ?? (env.AGENTLINK_OPEN_SIGNUP === "1" ? "open" : "email")) as SignupMode;
  if (!["email", "invite", "open"].includes(signup)) throw new Error(`AGENTLINK_SIGNUP must be email, invite or open (got ${signup})`);
  const base: Config = {
    host: env.HOST ?? "0.0.0.0",
    port,
    dataDir: path.resolve(env.AGENTLINK_DATA_DIR ?? "./data"),
    publicUrl: (env.AGENTLINK_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    adminToken: env.AGENTLINK_ADMIN_TOKEN ?? "",
    metricsToken: env.AGENTLINK_METRICS_TOKEN ?? "",
    signup,
    emailDomains: (env.AGENTLINK_EMAIL_DOMAINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    smtpUrl: env.AGENTLINK_SMTP_URL ?? "",
    mailFrom: env.AGENTLINK_MAIL_FROM ?? "AgentLink <no-reply@localhost>",
    trustProxy: env.AGENTLINK_TRUST_PROXY === "1",
    webhooks: (env.AGENTLINK_WEBHOOKS as Config["webhooks"]) ?? "public",
    logLevel: (env.LOG_LEVEL as Config["logLevel"]) ?? "info",
    quotas: {
      monthlyMessages: num(env.AGENTLINK_MONTHLY_MESSAGES, 0),
      maxDevices: num(env.AGENTLINK_MAX_DEVICES, 50),
      maxOnlineAgents: num(env.AGENTLINK_MAX_ONLINE_AGENTS, 100),
      maxAttachmentBytes: num(env.AGENTLINK_MAX_ATTACHMENT_BYTES, 25 * 1024 * 1024),
      queueTtlSec: num(env.AGENTLINK_QUEUE_TTL_SEC, 7 * 24 * 3600),
    },
    limits: {
      maxTextBytes: 64 * 1024,
      maxAttachmentsPerMessage: 5,
      maxFrameBytes: 256 * 1024,
      ephemeralGraceSec: 10 * 60,
      helloTimeoutMs: 10_000,
      idleTimeoutMs: 60_000,
      httpBurst: num(env.AGENTLINK_HTTP_BURST, 120),
      httpPerSec: num(env.AGENTLINK_HTTP_PER_SEC, 5),
      wsSendBurst: num(env.AGENTLINK_SEND_BURST, 30),
      wsSendPerSec: num(env.AGENTLINK_SEND_PER_SEC, 10),
      helloBurst: num(env.AGENTLINK_HELLO_BURST, 60),
      helloPerSec: num(env.AGENTLINK_HELLO_PER_SEC, 1),
      emailPerIpPerHour: num(env.AGENTLINK_EMAIL_PER_IP_HOUR, 20),
      pollOnlineMs: 60_000,
      redeliverAfterMs: 60_000,
    },
  };
  return {
    ...base,
    ...overrides,
    quotas: { ...base.quotas, ...(overrides.quotas ?? {}) },
    limits: { ...base.limits, ...(overrides.limits ?? {}) },
  };
}

/** 0 = unlimited */
export const within = (count: number, limit: number) => limit <= 0 || count < limit;
