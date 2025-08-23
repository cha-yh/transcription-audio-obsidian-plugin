import type { ProgressEvent } from '../types/progress';

type Handler = (e: ProgressEvent) => void;

class ProgressBus {
  private handlers: Set<Handler> = new Set();

  subscribe(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  publish(event: ProgressEvent): void {
    for (const h of Array.from(this.handlers)) {
      try {
        h(event);
      } catch (e) {
        console.error('[progressBus] handler error', e);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

export const progressBus = new ProgressBus();
