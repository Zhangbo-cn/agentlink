import path from "node:path";

export type Plan = {
  name: string;
  monthlyMessages: number;
  maxDevices: number;
  maxOnlineAgents: number;
  maxAttachmentBytes: number;
  /** How long a message waits for an offline persistent agent. */
  queueTtlSec: number;
};

export const DEFAULT_PLANS: Record<string, Plan> = {
  free: { name: "free", monthlyMessages: 2_000, maxDevices: 3, maxOnlineAgents: 5, maxAttachmentBytes: 5 * 1024 * 1024, queueTtlSec: 24 * 3600 },
  pro: { name: "pro", monthlyMessages: 100_000, maxDevices: 50, maxOnlineAgents: 100, maxAttachmentBytes: 25 * 1024 * 1024, queueTtlSec: 7 * 24 * 3600 },
};

export type Config = {
  host: string;
  port: number;
  dataDir: string;
  publicUrl: string;
  adminToken: string;
  metricsToken: string;
  openSignup: boolean;
  trustProxy: boolean;
  logLevel: "debug" | "info" | "warn" | "error" | "silent";
  plans: Record<string, Plan>;
  limits: {
    maxTextBytes: number;
    maxAttachmentsPerMessage: number;
    maxFrameBytes: number;
    ephemeralGraceSec: number;
    helloTimeoutMs: number;
    idleTimeoutMs: number;
    statusProbeTimeoutMs: number;
    httpBurst: number;
    httpPerSec: number;
    wsSendBurst: number;
    wsSendPerSec: number;
    helloBurst: number;
    helloPerSec: number;
  };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const plans = env.AGENTLINK_PLANS_JSON ? { ...DEFAULT_PLANS, ...(JSON.parse(env.AGENTLINK_PLANS_JSON) as Record<string, Plan>) } : DEFAULT_PLANS;
  const port = Number(env.PORT ?? 8787);
  const base: Config = {
    host: env.HOST ?? "0.0.0.0",
    port,
    dataDir: path.resolve(env.AGENTLINK_DATA_DIR ?? "./data"),
    publicUrl: env.AGENTLINK_PUBLIC_URL ?? `http://localhost:${port}`,
    adminToken: env.AGENTLINK_ADMIN_TOKEN ?? "",
    metricsToken: env.AGENTLINK_METRICS_TOKEN ?? "",
    openSignup: env.AGENTLINK_OPEN_SIGNUP === "1",
    trustProxy: env.AGENTLINK_TRUST_PROXY === "1",
    logLevel: (env.LOG_LEVEL as Config["logLevel"]) ?? "info",
    plans,
    limits: {
      maxTextBytes: 64 * 1024,
      maxAttachmentsPerMessage: 5,
      maxFrameBytes: 256 * 1024,
      ephemeralGraceSec: 10 * 60,
      helloTimeoutMs: 10_000,
      idleTimeoutMs: 60_000,
      statusProbeTimeoutMs: 3_000,
      httpBurst: Number(env.AGENTLINK_HTTP_BURST ?? 60),
      httpPerSec: Number(env.AGENTLINK_HTTP_PER_SEC ?? 2),
      wsSendBurst: Number(env.AGENTLINK_SEND_BURST ?? 30),
      wsSendPerSec: Number(env.AGENTLINK_SEND_PER_SEC ?? 10),
      helloBurst: Number(env.AGENTLINK_HELLO_BURST ?? 60),
      helloPerSec: Number(env.AGENTLINK_HELLO_PER_SEC ?? 1),
    },
  };
  return { ...base, ...overrides, limits: { ...base.limits, ...(overrides.limits ?? {}) } };
}
