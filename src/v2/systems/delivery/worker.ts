export interface DeliveryWorker {
  process(jobId: string, signal?: AbortSignal): Promise<void>;
}
