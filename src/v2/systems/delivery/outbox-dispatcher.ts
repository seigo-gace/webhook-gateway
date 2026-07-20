export interface OutboxDispatcher {
  dispatch(): Promise<void>;
}
