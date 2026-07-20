export interface ApplicationBootstrap {
  start(): Promise<void>;
  stop(): Promise<void>;
}
