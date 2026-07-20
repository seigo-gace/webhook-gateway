export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerState {
  state: CircuitState;
  failures: number;
  updatedAt: Date;
}

export interface CircuitBreakerStateStore {
  get(destinationId: string): Promise<CircuitBreakerState | null>;
  set(destinationId: string, state: CircuitBreakerState): Promise<void>;
}

export class RedisCircuitBreakerStateStore implements CircuitBreakerStateStore {
  async get(_destinationId: string): Promise<CircuitBreakerState | null> {
    return null;
  }

  async set(_destinationId: string, _state: CircuitBreakerState): Promise<void> {}
}
