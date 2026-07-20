export interface OutboxRecord {
  id: string;
  eventId: string;
  status: 'PENDING' | 'SENT' | 'FAILED' | 'DEAD';
  retryCount: number;
}

export interface OutboxRepository {
  findPending(limit: number): Promise<OutboxRecord[]>;
  markSent(id: string): Promise<void>;
  markFailed(id: string, reason: string): Promise<void>;
  restorePending(id: string): Promise<void>;
}
