import type { WebhookVerifier } from './verifier';
import type { VerifierRegistry } from './verifier-registry';

export interface VerificationService {
  verify(provider: string, payload: Uint8Array, headers: Record<string, string>): Promise<boolean>;
}

export class DefaultVerificationService implements VerificationService {
  constructor(private readonly registry: VerifierRegistry) {}

  async verify(provider: string, payload: Uint8Array, headers: Record<string, string>): Promise<boolean> {
    const verifier: WebhookVerifier | undefined = this.registry.resolve(provider);
    if (!verifier) return false;
    return verifier.verify(payload, headers);
  }
}
