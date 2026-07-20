export interface AdminPrincipal {
  id: string;
  role: 'ADMIN';
}

export interface AdminAuthorizer {
  authorize(token: string): Promise<AdminPrincipal | null>;
}
