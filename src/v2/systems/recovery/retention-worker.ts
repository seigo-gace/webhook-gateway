export interface RetentionWorker {
  execute(signal?: AbortSignal): Promise<void>;
}
