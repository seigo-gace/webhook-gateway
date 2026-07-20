export interface StoredEvent {
  id: string;
  tenantId: string;
  provider: string;
  providerEventId: string;
  payload: unknown;
}

export interface EventRepository {
  findByProviderEventId(provider: string, providerEventId: string): Promise<StoredEvent | null>;
  save(event: StoredEvent): Promise<void>;
}
