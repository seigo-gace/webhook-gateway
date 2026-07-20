export interface ReplayGuardResult {
  allowed: boolean;
  reason?: string;
}

export interface ReplayGuard {
  check(provider: string, eventId: string): Promise<ReplayGuardResult>;
  register(provider: string, eventId: string): Promise<void>;
}
