import type { Env } from "./index";
import type { ForwardedMedia } from "./telegram-webhook";
import { type BatchMessage, type BufferedMessage, forwardToGrokBot, resolveMedia } from "./telegram-webhook";

export const DEFAULT_DEBOUNCE_MS = 2000;
const MAX_DEBOUNCE_MS = 60_000;
// Each media item costs one getFile subrequest at flush time, so a batch stays
// well under the Workers subrequest limit.
export const MAX_BATCH = 20;
const PREFIX = "msg:";

// Zero-padded ids make storage order match message order, so album parts that
// arrive out of order sort themselves, and a redelivered update overwrites itself.
const keyFor = (messageId: number) => `${PREFIX}${String(messageId).padStart(16, "0")}`;

export function debounceMs(env: Env): number {
  const raw = env.DEBOUNCE_MS?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return DEFAULT_DEBOUNCE_MS;
  return Math.min(Number(raw), MAX_DEBOUNCE_MS);
}

interface AddRequest {
  origin: string;
  chat_id: number;
  message: BufferedMessage;
}

export async function bufferMessage(env: Env, origin: string, chatId: number, message: BufferedMessage): Promise<void> {
  const stub = env.CHAT_BUFFER.get(env.CHAT_BUFFER.idFromName(String(chatId)));
  const body: AddRequest = { origin, chat_id: chatId, message };
  const res = await stub.fetch("https://chat-buffer/add", { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`chat buffer returned HTTP ${res.status}`);
}

type ResolvedMessage = Omit<BufferedMessage, "media"> & { media?: ForwardedMedia };

export function groupBatch(messages: ResolvedMessage[]): BatchMessage[] {
  const batch: BatchMessage[] = [];
  const albums = new Map<string, BatchMessage>();
  for (const { media, ...message } of messages) {
    const album = message.media_group_id ? albums.get(message.media_group_id) : undefined;
    if (album) {
      if (media) album.media = [...(album.media ?? []), media];
      album.caption ??= message.caption;
      continue;
    }
    const entry: BatchMessage = { ...message, ...(media ? { media: [media] } : {}) };
    if (message.media_group_id) albums.set(message.media_group_id, entry);
    batch.push(entry);
  }
  return batch;
}

/** One instance per chat. Holds messages until DEBOUNCE_MS passes with no new one, then forwards them as one batch. */
export class ChatBuffer implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const { origin, chat_id, message } = await request.json<AddRequest>();
    const storage = this.state.storage;
    await storage.put({ origin, chat_id, [keyFor(message.message_id)]: message });
    const buffered = await storage.list({ prefix: PREFIX, limit: MAX_BATCH });
    await storage.setAlarm(Date.now() + (buffered.size >= MAX_BATCH ? 0 : debounceMs(this.env)));
    return new Response(null, { status: 204 });
  }

  async alarm(): Promise<void> {
    const storage = this.state.storage;
    const entries = await storage.list<BufferedMessage>({ prefix: PREFIX, limit: MAX_BATCH });
    if (entries.size === 0) return;
    const origin = (await storage.get<string>("origin")) ?? "";
    const chatId = (await storage.get<number>("chat_id")) ?? 0;

    // Removed before forwarding, so a crash mid-forward loses the batch rather
    // than running the routine twice. That matches the no-retry rule for sends.
    await storage.delete([...entries.keys()]);
    if ((await storage.list({ prefix: PREFIX, limit: 1 })).size > 0) await storage.setAlarm(Date.now());

    const resolved = await Promise.all(
      [...entries.values()].map(async ({ media, ...message }): Promise<ResolvedMessage> =>
        media ? { ...message, media: await resolveMedia(this.env, origin, media) } : message,
      ),
    );
    await forwardToGrokBot(this.env, { chat_id: chatId, messages: groupBatch(resolved) });
  }
}
