export interface WebhookVerifier {
  readonly provider: string;
  verify(input: {
    rawBody: string;
    headers: Record<string, string | undefined>;
    secret: string;
  }): Promise<boolean>;
}
