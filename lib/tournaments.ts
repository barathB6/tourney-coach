export const FORMATS = ['scramble', 'best_ball', 'alternate_shot', 'stroke_play'] as const;
export const MAX_SCORE_RULES = ['par', 'double_bogey', 'none'] as const;
export const START_METHODS = ['single', 'double', 'wave', 'tee_times'] as const;
export const STATUSES = ['draft', 'published', 'live', 'completed'] as const;

export type TournamentFormat = (typeof FORMATS)[number];
export type MaxScoreRule = (typeof MAX_SCORE_RULES)[number];
export type StartMethod = (typeof START_METHODS)[number];
export type TournamentStatus = (typeof STATUSES)[number];

export interface TournamentInput {
  name: string;
  organization?: string;
  event_date: string;
  course_id?: string;
  custom_course_name?: string;
  custom_course_city?: string;
  custom_course_state?: string;
  format?: TournamentFormat;
  team_size?: number;
  max_score_rule?: MaxScoreRule;
  shotgun_type?: StartMethod;
  max_players?: number;
  entry_fee?: number;
  cause_what?: string;
  cause_who?: string;
  cause_why?: string;
}

// --- Validation ---

export interface ValidationError {
  field: string;
  message: string;
}

export function validateTournament(data: Partial<TournamentInput>): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!data.name || data.name.trim().length === 0) {
    errors.push({ field: 'name', message: 'Tournament name is required' });
  } else if (data.name.trim().length > 200) {
    errors.push({ field: 'name', message: 'Tournament name must be under 200 characters' });
  }

  if (!data.event_date) {
    errors.push({ field: 'event_date', message: 'Event date is required' });
  } else {
    const date = new Date(data.event_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (isNaN(date.getTime())) {
      errors.push({ field: 'event_date', message: 'Invalid date' });
    } else if (date < today) {
      errors.push({ field: 'event_date', message: 'Event date must be in the future' });
    }
  }

  if (!data.course_id && !data.custom_course_name) {
    errors.push({ field: 'course_id', message: 'Select a course or enter one manually' });
  }

  if (data.course_id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.course_id)) {
    errors.push({ field: 'course_id', message: 'Invalid course ID' });
  }

  if (data.format && !FORMATS.includes(data.format)) {
    errors.push({ field: 'format', message: `Format must be one of: ${FORMATS.join(', ')}` });
  }

  if (data.team_size !== undefined && (data.team_size < 2 || data.team_size > 5)) {
    errors.push({ field: 'team_size', message: 'Team size must be between 2 and 5' });
  }

  if (data.max_score_rule && !MAX_SCORE_RULES.includes(data.max_score_rule)) {
    errors.push({ field: 'max_score_rule', message: `Max score rule must be one of: ${MAX_SCORE_RULES.join(', ')}` });
  }

  if (data.shotgun_type && !START_METHODS.includes(data.shotgun_type)) {
    errors.push({ field: 'shotgun_type', message: `Start method must be one of: ${START_METHODS.join(', ')}` });
  }

  if (data.max_players !== undefined && (data.max_players < 1 || data.max_players > 300)) {
    errors.push({ field: 'max_players', message: 'Player count must be between 1 and 300' });
  }

  if (data.entry_fee !== undefined && data.entry_fee < 0) {
    errors.push({ field: 'entry_fee', message: 'Entry fee cannot be negative' });
  }

  return errors;
}

// --- State Machine ---

const VALID_TRANSITIONS: Record<TournamentStatus, TournamentStatus[]> = {
  draft: ['published'],
  published: ['live', 'draft'],
  live: ['completed'],
  completed: [],
};

export function canTransition(from: TournamentStatus, to: TournamentStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function getTimestampField(status: TournamentStatus): string | null {
  switch (status) {
    case 'published': return 'published_at';
    case 'live': return 'live_at';
    case 'completed': return 'completed_at';
    default: return null;
  }
}
