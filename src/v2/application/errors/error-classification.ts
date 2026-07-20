export type ErrorCategory =
  | 'VALIDATION'
  | 'SECURITY'
  | 'RETRYABLE'
  | 'RECOVERY'
  | 'INTERNAL';

export interface ClassifiedError {
  category: ErrorCategory;
  code: string;
  retryable: boolean;
}
