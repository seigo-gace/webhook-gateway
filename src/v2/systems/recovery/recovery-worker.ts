export interface RecoveryWorker {
  recover(): Promise<void>;
}

export interface RetentionStateRepository {
  getLastCompletedAt(jobName: string): Promise<Date | null>;
  markCompleted(jobName: string, completedAt: Date): Promise<void>;
}
