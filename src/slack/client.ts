import { deterministicUuid } from "../domain/safety.js";

export type SlackBlock = Record<string, unknown>;
export interface SlackMessage {
  text: string;
  blocks: SlackBlock[];
}

export interface SlackPostResult {
  channelId: string;
  messageTs: string;
}

export interface SlackClient {
  post(channelId: string, message: SlackMessage, idempotencyKey: string, threadTs?: string): Promise<SlackPostResult>;
  update(channelId: string, messageTs: string, message: SlackMessage): Promise<SlackPostResult>;
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  channel?: string;
  ts?: string;
}

export class HttpSlackClient implements SlackClient {
  constructor(private readonly token: string) {}

  async post(channelId: string, message: SlackMessage, idempotencyKey: string, threadTs?: string): Promise<SlackPostResult> {
    return this.call("chat.postMessage", {
      channel: channelId,
      ...message,
      client_msg_id: deterministicUuid(idempotencyKey),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  }

  async update(channelId: string, messageTs: string, message: SlackMessage): Promise<SlackPostResult> {
    return this.call("chat.update", { channel: channelId, ts: messageTs, ...message });
  }

  private async call(method: string, body: Record<string, unknown>): Promise<SlackPostResult> {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as SlackApiResponse;
    if (!response.ok || !result.ok || !result.channel || !result.ts) {
      throw new Error(`Slack API ${method} failed: ${result.error ?? response.status}`);
    }
    return { channelId: result.channel, messageTs: result.ts };
  }
}

export class MemorySlackClient implements SlackClient {
  readonly posts: Array<{ channelId: string; message: SlackMessage; key: string; threadTs?: string }> = [];
  readonly updates: Array<{ channelId: string; messageTs: string; message: SlackMessage }> = [];

  async post(channelId: string, message: SlackMessage, key: string, threadTs?: string): Promise<SlackPostResult> {
    this.posts.push({ channelId, message, key, ...(threadTs ? { threadTs } : {}) });
    return { channelId, messageTs: String(1_000_000 + this.posts.length) };
  }

  async update(channelId: string, messageTs: string, message: SlackMessage): Promise<SlackPostResult> {
    this.updates.push({ channelId, messageTs, message });
    return { channelId, messageTs };
  }
}

export class StdoutSlackClient extends MemorySlackClient {
  override async post(channelId: string, message: SlackMessage, key: string, threadTs?: string): Promise<SlackPostResult> {
    const result = await super.post(channelId, message, key, threadTs);
    process.stdout.write(`${JSON.stringify({ operation: "chat.postMessage", channelId, key, threadTs, ...message }, null, 2)}\n`);
    return result;
  }

  override async update(channelId: string, messageTs: string, message: SlackMessage): Promise<SlackPostResult> {
    const result = await super.update(channelId, messageTs, message);
    process.stdout.write(`${JSON.stringify({ operation: "chat.update", channelId, messageTs, ...message }, null, 2)}\n`);
    return result;
  }
}
