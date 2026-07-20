export interface ReceiveRequest {
  readonly tenantId: string;
  readonly provider: string;
  readonly rawBody: Uint8Array;
  readonly headers: Record<string, string>;
}

export interface ReceiveResult {
  readonly accepted: boolean;
  readonly eventId?: string;
}

export interface ReceiveController {
  handle(request: ReceiveRequest): Promise<ReceiveResult>;
}
