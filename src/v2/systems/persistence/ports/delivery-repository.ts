export interface DeliveryRecord {
  id: string;
  eventId: string;
  destinationId: string;
  status: 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED' | 'DEAD';
}

export interface DeliveryRepository {
  findPending(limit: number): Promise<DeliveryRecord[]>;
  markProcessing(id: string, leaseUntil: Date): Promise<void>;
  markSuccess(id: string): Promise<void>;
  markFailed(id: string, reason: string): Promise<void>;
}
