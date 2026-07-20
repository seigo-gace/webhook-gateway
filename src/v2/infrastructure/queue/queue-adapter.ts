export interface QueueAdapter {
  enqueue(name: string, payload: unknown): Promise<void>;
  dequeue(name: string): Promise<unknown | null>;
}
