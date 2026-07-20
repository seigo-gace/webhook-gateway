export interface PostgresAdapter {
  transaction<T>(handler: () => Promise<T>): Promise<T>;
}
