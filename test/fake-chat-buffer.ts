import { ChatBuffer } from "../src/chat-buffer";
import type { Env } from "../src/index";

class FakeStorage {
  private data = new Map<string, unknown>();
  private timer?: ReturnType<typeof setTimeout>;
  alarmAt: number | null = null;

  constructor(private readonly fire: () => void) {}

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }

  async put(entries: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(entries)) this.data.set(k, structuredClone(v));
  }

  async delete(keys: string[]): Promise<void> {
    for (const k of keys) this.data.delete(k);
  }

  async list<T>({ prefix = "", limit = Infinity }: { prefix?: string; limit?: number } = {}): Promise<Map<string, T>> {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit);
    return new Map(keys.map((k) => [k, structuredClone(this.data.get(k)) as T]));
  }

  async setAlarm(at: number): Promise<void> {
    this.cancelAlarm();
    this.alarmAt = at;
    this.timer = setTimeout(() => {
      this.alarmAt = null;
      this.fire();
    }, Math.max(0, at - Date.now()));
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  cancelAlarm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.alarmAt = null;
  }
}

/** Stands in for the CHAT_BUFFER namespace: one real ChatBuffer per chat, with in-memory storage and timer-driven alarms. */
export function fakeChatBuffers() {
  const instances = new Map<string, { buffer: ChatBuffer; storage: FakeStorage }>();
  const running: Promise<void>[] = [];
  let currentEnv: Env;

  function instance(name: string) {
    let entry = instances.get(name);
    if (!entry) {
      const storage: FakeStorage = new FakeStorage(() => running.push(buffer.alarm()));
      const buffer: ChatBuffer = new ChatBuffer({ storage } as unknown as DurableObjectState, currentEnv);
      entry = { buffer, storage };
      instances.set(name, entry);
    }
    return entry;
  }

  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: ({ name }: { name: string }) => ({
      fetch: (url: string, init?: RequestInit) => instance(name).buffer.fetch(new Request(url, init)),
    }),
  } as unknown as DurableObjectNamespace;

  return {
    namespace(env: Env): DurableObjectNamespace {
      currentEnv = env;
      return namespace;
    },
    chats: () => [...instances.keys()],
    /** Waits for alarms that already fired. */
    async settled(): Promise<void> {
      while (running.length) await running.shift();
    },
    /** Fires every pending alarm now, as if the debounce window had passed. */
    async flush(): Promise<void> {
      await this.settled();
      for (let due = true; due; ) {
        due = false;
        for (const { buffer, storage } of instances.values()) {
          if (storage.alarmAt === null) continue;
          storage.cancelAlarm();
          due = true;
          await buffer.alarm();
        }
      }
    },
    reset(): void {
      for (const { storage } of instances.values()) storage.cancelAlarm();
      instances.clear();
      running.length = 0;
    },
  };
}
