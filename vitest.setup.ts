// Vitest global setup.
//
// lib/state.ts builds a Zustand store with the `persist` middleware, whose default
// storage is localStorage. Importing the store under Node (where localStorage is
// undefined) would otherwise crash. Provide an in-memory shim so the store hydrates
// cleanly without touching the real browser environment.

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

const g = globalThis as unknown as { localStorage: Storage };

if (!g.localStorage) {
  g.localStorage = new MemoryStorage();
}
