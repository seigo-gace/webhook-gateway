export interface DeliveryCommand {
  readonly deliveryId: string;
  readonly destination: string;
  readonly payload: Uint8Array;
}

export interface DeliveryResult {
  readonly success: boolean;
  readonly retryable: boolean;
}

export interface DeliveryService {
  execute(command: DeliveryCommand): Promise<DeliveryResult>;
}
