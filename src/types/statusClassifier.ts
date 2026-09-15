export type StatusCategory =
  | 'link_sent'
  | 'repeat_sent'
  | 'declined'
  | 'already_registered'
  | 'wrong_person'
  | 'unknown';

export type ClassificationSource = 'rule' | 'ai' | 'manual';

export interface RuleMatchResult {
  category?: StatusCategory | null;
  confidence?: number;
}

export interface StatusResult {
  category: StatusCategory;
  confidence: number;
  source: ClassificationSource;
}
