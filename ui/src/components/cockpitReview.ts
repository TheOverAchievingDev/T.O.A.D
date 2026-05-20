export interface CockpitReviewPayload {
  summary?: string | null;
  files?: string[];
  scopeDrift?: string[];
  noOpDiff?: boolean;
  reviewerId?: string | null;
  requestedAt?: string;
  decision?: string | null;
  reason?: string | null;
}

export interface CockpitValidationSummaryInput {
  kind?: string;
  verdict?: string;
}

export interface CockpitReviewSummary {
  state: 'waiting' | 'ready' | 'blocked' | 'empty';
  fileCount: number;
  scopeDriftCount: number;
  validationLabel: string;
}

export function summarizeCockpitReview({
  review,
  validations = [],
}: {
  review?: CockpitReviewPayload | null;
  validations?: CockpitValidationSummaryInput[];
}): CockpitReviewSummary {
  const passed = validations.filter((run) => run.verdict === 'passed').length;
  const failed = validations.filter((run) => run.verdict === 'failed').length;
  const notRun = validations.filter((run) => run.verdict === 'not_run').length;
  const validationParts = [`${passed} pass`];
  if (failed > 0) validationParts.push(`${failed} fail`);
  if (notRun > 0) validationParts.push(`${notRun} not run`);

  if (!review) {
    return {
      state: validations.length > 0 && failed === 0 ? 'waiting' : 'empty',
      fileCount: 0,
      scopeDriftCount: 0,
      validationLabel: validations.length > 0 ? validationParts.join(' / ') : 'No validations',
    };
  }

  const fileCount = review.files?.length ?? 0;
  const scopeDriftCount = review.scopeDrift?.length ?? 0;
  const state = failed > 0 || scopeDriftCount > 0 || review.noOpDiff === true
    ? 'blocked'
    : 'ready';

  return {
    state,
    fileCount,
    scopeDriftCount,
    validationLabel: validations.length > 0 ? validationParts.join(' / ') : 'No validations',
  };
}
