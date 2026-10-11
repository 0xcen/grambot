import { OwnerStore } from "../src/owner-store";
import { FakeStorage } from "./fake-chat-buffer";

/** Stands in for the OWNER_STORE namespace: one real OwnerStore with in-memory storage. */
export function fakeOwnerStore() {
  let storage = new FakeStorage(() => {});
  let store = new OwnerStore({ storage } as unknown as DurableObjectState);

  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({ fetch: (url: string, init?: RequestInit) => store.fetch(new Request(url, init)) }),
  } as unknown as DurableObjectNamespace;

  return {
    namespace,
    storage: () => storage,
    reset(): void {
      storage = new FakeStorage(() => {});
      store = new OwnerStore({ storage } as unknown as DurableObjectState);
    },
  };
}
