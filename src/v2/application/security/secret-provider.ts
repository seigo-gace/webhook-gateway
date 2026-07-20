export interface SecretProvider {
  getSecret(name: string): Promise<string | null>;
}
