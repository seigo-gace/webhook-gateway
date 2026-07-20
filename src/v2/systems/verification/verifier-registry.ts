import type { WebhookVerifier } from './verifier.js';

export interface VerifierRegistry {
  register(verifier: WebhookVerifier): void;
  resolve(provider: string): WebhookVerifier | undefined;
}

export class DefaultVerifierRegistry implements VerifierRegistry {
  private readonly verifiers = new Map<string, WebhookVerifier>();

  register(verifier: WebhookVerifier): void {
    this.verifiers.set(verifier.provider, verifier);
  }

  resolve(provider: string): WebhookVerifier | undefined {
    return this.verifiers.get(provider);
  }
}
