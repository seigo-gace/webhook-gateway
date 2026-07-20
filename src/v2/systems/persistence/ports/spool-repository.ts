export interface SpoolRecord {
  id: string;
  payload: string;
  hmac: string;
  createdAt: Date;
}

export interface SpoolRepository {
  save(record: SpoolRecord): Promise<void>;
  listPending(limit: number): Promise<SpoolRecord[]>;
  remove(id: string): Promise<void>;
}
