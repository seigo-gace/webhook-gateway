export interface SecretAdapter {
  getSecret(name: string): Promise<string>;
}
