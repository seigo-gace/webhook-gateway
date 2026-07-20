export interface TenantContext {
  tenantId: string;
}

export class TenantResolver {
  resolve(value?: string): TenantContext {
    if (!value) {
      throw new Error("TENANT_REQUIRED");
    }

    return { tenantId: value };
  }
}
