/** Raw JSON shape returned by `tessl eval run --json` */
export interface EvalRunResponse {
  id: string;
  status: string;
}

/** Raw assessment criterion from `tessl eval view --json` */
export interface RawAssessmentResult {
  name: string;
  score: number;
  max_score: number;
  reasoning: string;
}

/** Raw solution from `tessl eval view --json` */
export interface RawSolution {
  scenario_fingerprint: string;
  variant: string;
  score: number;
  assessment_results: RawAssessmentResult[];
}

/** Parsed per-criterion result */
export interface EvalCriterion {
  name: string;
  score: number;
  maxScore: number;
  reasoning: string;
}

/** Parsed per-scenario result (baseline + with-context paired) */
export interface EvalScenario {
  name: string;
  baselineScore: number;
  withContextScore: number;
  delta: number;
  criteria: EvalCriterion[];
}

/** Final result for one tile's eval run */
export interface EvalResult {
  tilePath: string;
  runId: string;
  status: 'completed' | 'failed' | 'timeout';
  overallScore: number;
  scenarios: EvalScenario[];
  error?: string;
}
