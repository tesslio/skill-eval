/** Raw JSON shape returned by `tessl eval run --json` (array element) */
export interface EvalRunResponse {
  evalRunId: string;
  agent: string;
  model: string;
  scenariosCount: number;
}

/** Raw assessment criterion from eval view */
export interface RawAssessmentResult {
  name: string;
  score: number;
  max_score: number;
  reasoning: string;
}

/** Raw solution from eval view (nested under scenario) */
export interface RawSolution {
  id: string;
  variant: string;
  assessmentResults: RawAssessmentResult[];
}

/** Raw scenario from eval view (data.attributes.scenarios[]) */
export interface RawScenario {
  id: string;
  fingerprint: string;
  solutions: RawSolution[];
}

/** JSON:API response from `tessl eval view --json` */
export interface EvalViewResponse {
  data: {
    id: string;
    attributes: {
      status: string;
      scenarios: RawScenario[];
    };
  };
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
