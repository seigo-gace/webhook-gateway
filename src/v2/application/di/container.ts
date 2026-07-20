export interface DependencyContainer {
  resolve<T>(token: string): T;
  register<T>(token: string, value: T): void;
}

export class ApplicationContainer implements DependencyContainer {
  private readonly bindings = new Map<string, unknown>();

  resolve<T>(token: string): T {
    return this.bindings.get(token) as T;
  }

  register<T>(token: string, value: T): void {
    this.bindings.set(token, value);
  }
}
