export interface CallSubmission {
  operatorId: string;
  phone: string;
  startedAt: string;
  endedAt?: string;
  status: string;
  comment?: string;
  clientName?: string;
  metadata?: Record<string, string | number | boolean | null>;
}
