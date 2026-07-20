export interface SSRFGuardResult {
  allowed: boolean;
  resolvedIp?: string;
  reason?: string;
}

export interface SSRFGuard {
  validate(destination: string): Promise<SSRFGuardResult>;
}
