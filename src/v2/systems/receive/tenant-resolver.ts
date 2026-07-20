export interface TenantContext {
  tenantId: string;
}

export interface TenantResolver {
  resolve(headers: Record<string, string>): Promise<TenantContext | null>;
}
