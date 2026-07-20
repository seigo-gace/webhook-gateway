export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerState {
  state: CircuitState;
  failureCount: number;
  lastFailureAt?: Date;
  openedAt?: Date;
}

export interface CircuitBreakerStateStore {
  get(destinationId: string): Promise<CircuitBreakerState | null>;
  set(destinationId: string, state: CircuitBreakerState): Promise<void>;
  allowHalfOpen(destinationId: string): Promise<boolean>;
}
