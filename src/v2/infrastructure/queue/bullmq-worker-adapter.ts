export interface QueueWorkerAdapter {
  start(signal?: AbortSignal): Promise<void>;
}
