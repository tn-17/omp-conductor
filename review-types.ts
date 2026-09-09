export interface VerificationConfig {
  readonly argv: readonly string[];
  readonly timeoutMs: number;
}

export interface VerificationReport {
  argv: string[];
  status: "passed" | "failed" | "cancelled" | "timed-out";
  exitCode: number | null;
  output: string;
  truncated: boolean;
  durationMs: number;
}

export interface ReviewFinding {
  id: string;
  file: string;
  line: number;
  severity: "high" | "medium" | "low";
  title: string;
  evidence: string;
  expected: string;
}

export interface ReviewReport {
  summary: string;
  findings: ReviewFinding[];
}

export interface ReviewPass {
  pass: number;
  verification?: VerificationReport;
  review?: ReviewReport;
  reviewer?: { model?: string; id?: string; outputPath?: string };
  implementer?: { model?: string; id?: string; outputPath?: string };
  error?: string;
}

export interface ReviewHistory {
  status: "clean" | "needs-attention" | "failed" | "cancelled";
  passes: ReviewPass[];
}
