export interface CryptoProvider {
  encrypt(data: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}
