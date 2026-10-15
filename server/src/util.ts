import crypto from "node:crypto";

export const now = () => Date.now();

/** Random URL-safe id with a type prefix, e.g. ag_3kf9... */
export function id(prefix: string, bytes = 9): string {
  return `${prefix}_${crypto.randomBytes(bytes).toString("base64url")}`;
}

/** Secrets are high-entropy random strings, so a plain SHA-256 is an adequate at-rest hash. */
export function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

export function secret(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(24).toString("base64url")}`;
}

/** Human-typable code: 8 chars from an unambiguous alphabet, formatted XXXX-XXXX. */
export function shortCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export function normalizeCode(code: string): string {
  const c = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function period(at = now()): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function periodEnd(at = now()): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

const ADJ = ["amber", "bold", "brave", "bright", "calm", "clever", "cosmic", "crisp", "eager", "gentle", "golden", "happy", "jolly", "keen", "lucid", "lunar", "mellow", "misty", "noble", "polar", "quick", "quiet", "rapid", "silent", "solar", "steady", "swift", "tidy", "vivid", "witty"];
const NOUN = ["badger", "comet", "coral", "crane", "delta", "ember", "falcon", "fern", "harbor", "heron", "island", "lark", "maple", "meadow", "otter", "panda", "pine", "planet", "raven", "reef", "river", "robin", "sparrow", "spruce", "stone", "tiger", "tundra", "valley", "willow", "zephyr"];

export function randomName(): string {
  return `${ADJ[crypto.randomInt(ADJ.length)]}-${NOUN[crypto.randomInt(NOUN.length)]}`;
}

export const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

export class Logger {
  private static order = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
  constructor(private level: keyof typeof Logger.order) {}
  private write(level: keyof typeof Logger.order, msg: string, fields?: Record<string, unknown>) {
    if (Logger.order[level] < Logger.order[this.level]) return;
    process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }) + "\n");
  }
  debug(msg: string, f?: Record<string, unknown>) { this.write("debug", msg, f); }
  info(msg: string, f?: Record<string, unknown>) { this.write("info", msg, f); }
  warn(msg: string, f?: Record<string, unknown>) { this.write("warn", msg, f); }
  error(msg: string, f?: Record<string, unknown>) { this.write("error", msg, f); }
}

/** Token bucket keyed by an arbitrary string. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private capacity: number, private refillPerSec: number) {}
  take(key: string, cost = 1): boolean {
    const t = now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.refillPerSec);
    b.at = t;
    if (b.tokens < cost) { this.buckets.set(key, b); return false; }
    b.tokens -= cost;
    this.buckets.set(key, b);
    return true;
  }
  sweep(): void {
    const t = now();
    for (const [k, b] of this.buckets) if (t - b.at > 10 * 60_000) this.buckets.delete(k);
  }
}

export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, () => number>();
  inc(name: string, by = 1) { this.counters.set(name, (this.counters.get(name) ?? 0) + by); }
  gauge(name: string, fn: () => number) { this.gauges.set(name, fn); }
  get(name: string) { return this.counters.get(name) ?? 0; }
  render(): string {
    const lines: string[] = [];
    for (const [k, v] of this.counters) lines.push(`# TYPE agentlink_${k} counter`, `agentlink_${k} ${v}`);
    for (const [k, fn] of this.gauges) lines.push(`# TYPE agentlink_${k} gauge`, `agentlink_${k} ${fn()}`);
    return lines.join("\n") + "\n";
  }
}
