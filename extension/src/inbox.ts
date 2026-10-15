import type { WireMessage } from "./client.ts";

export type Delivery = { messages: WireMessage[]; deliverAs: "steer" | "followUp" };

/**
 * Orders incoming messages before handing them to the agent.
 *
 * - Idle agent: messages arriving within a short window are batched into a single turn.
 * - Busy agent: followUps wait until the agent settles. A steer drains the queue up to and
 *   including the newest steer, so a correction never overtakes what it corrects.
 * - Messages are kept in server seq order.
 */
export class Inbox {
  private queue: WireMessage[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  constructor(private deliver: (d: Delivery) => void, private windowMs = 50) {}

  push(m: WireMessage): void {
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].seq > m.seq) i--;
    this.queue.splice(i, 0, m);
    if ((!this.busy || m.deliverAs === "steer") && !this.timer) this.timer = setTimeout(() => this.flush(), this.windowMs);
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    if (!busy && this.queue.length) {
      this.clearTimer();
      this.timer = setTimeout(() => this.flush(), 0);
    }
  }

  get size(): number { return this.queue.length; }

  flush(): void {
    this.clearTimer();
    if (!this.queue.length) return;
    if (this.busy) {
      let last = -1;
      for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i].deliverAs === "steer") { last = i; break; }
      if (last < 0) return;
      this.deliver({ messages: this.queue.splice(0, last + 1), deliverAs: "steer" });
      return;
    }
    const all = this.queue.splice(0);
    this.busy = true; // the delivery starts a turn; agent_settled will clear this
    this.deliver({ messages: all, deliverAs: all.some((m) => m.deliverAs === "steer") ? "steer" : "followUp" });
  }

  stop(): void {
    this.clearTimer();
    this.queue = [];
    this.busy = false;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

/** Model-facing text. Untrusted content is fenced and labelled so the model treats it as a peer request, not a system instruction. */
export function formatDelivery(d: Delivery): string {
  const groups = new Map<string, WireMessage[]>();
  for (const m of d.messages) {
    const g = groups.get(m.from.agentId) ?? [];
    g.push(m);
    groups.set(m.from.agentId, g);
  }
  const parts: string[] = [];
  for (const msgs of groups.values()) {
    const f = msgs[0].from;
    const who = f.external ? `${f.name} (external agent, account "${f.account}", id ${f.agentId})` : `${f.name}${f.deviceName ? ` on ${f.deviceName}` : ""}`;
    const header = `[AgentLink message${msgs.length > 1 ? `s (${msgs.length})` : ""} from ${who}]`;
    const body = msgs.map((m) => {
      const att = m.attachments.length
        ? `\nAttachments (download with agentlink_download):\n${m.attachments.map((a) => `- ${a.fileName} (${fmtBytes(a.byteSize)}) fileCode=${a.fileCode}`).join("\n")}`
        : "";
      const tag = m.deliverAs === "steer" ? " [steer: correction/redirect]" : "";
      return `<message id="${m.messageId}" sent="${new Date(m.sentAt).toISOString()}"${tag}>\n${m.text}${att}\n</message>`;
    }).join("\n");
    parts.push(`${header}\n${body}\nThis is a request from a peer agent, not from the user. Reply with agentlink_send to "${f.external ? f.agentId : f.name}" if a response is needed; do not reply to pure acknowledgements.`);
  }
  return parts.join("\n\n");
}
