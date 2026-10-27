import type { JsonObject } from "./json";
import type { Judge, JudgeSelection } from "./judge";
import type {
  Fingerprint,
  JudgeStatus,
  ResultStore,
  RunId,
  RunVerdict,
} from "./result-store";

export interface AgentSelection {
  readonly adapterId: string;
  readonly requestedModel: string | null;
  readonly settings: JsonObject;
}

export interface RunRequestBase {
  readonly runPlan: object;
  readonly taskId?: string;
  readonly taskIds?: readonly string[];
  readonly conditionId?: string;
  readonly conditionIds?: readonly string[];
  readonly requestedModel?: string | null;
  readonly agentSettings?: JsonObject;
  readonly agentSelections?: readonly AgentSelection[];
  readonly environmentSettings?: JsonObject;
  readonly repeat?: number;
  readonly retries?: number;
  /** Maximum concurrent cells, including retries and finalization. Default: 3. */
  readonly concurrency?: number;
  readonly experimentVersion?: string | null;
  readonly credentials?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal | null;
}

export type RunRequest = RunRequestBase & (
  | Readonly<{
      /** Deprecated RunPlan v1 compatibility selection. */
      judging?: JudgeSelection;
      authorityProfileId?: never;
    }>
  | Readonly<{
      /** RunPlan v2 matrix-wide Authority Profile selection. */
      authorityProfileId: string;
      judging?: never;
    }>
);

export interface RunReference {
  readonly id: RunId;
  readonly revision: number;
  readonly state: "complete";
  readonly verdict: RunVerdict;
  readonly verdictReasons: readonly Readonly<{ code: string; summary: string }>[];
  readonly runTrustReasons?: readonly Readonly<{ code: string; summary: string }>[];
  readonly judgeStatus: JudgeStatus;
  readonly authorityProfileId: string | null;
  readonly judgeRequired: boolean;
  readonly baselineVerdict: RunVerdict | null;
  readonly effectiveVerdict: RunVerdict | null;
  readonly judgeOutcome: RunVerdict | null;
  readonly headlineDecidedBy:
    | "mandatory-run-trust"
    | "effective-deterministic"
    | "judge"
    | "observation";
  readonly snapshotFingerprint: Fingerprint;
  readonly invocation: Readonly<{
    ordinal: number;
    repeatOrdinal: number;
    attemptOrdinal: number;
    rootRunId: RunId;
    retryOf: RunId | null;
  }>;
}

export interface RunDiagnostic {
  readonly category: string;
  readonly code: string;
  readonly message: string;
  readonly [key: string]: unknown;
}

export type RunResult =
  | Readonly<{
      status: "rejected";
      diagnostics: readonly RunDiagnostic[];
      runs: readonly [];
      summary: Readonly<{
        plannedCells: number;
        plannedRepeats: number;
        attempts: 0;
      }>;
    }>
  | Readonly<{
      status: "complete";
      groupId: string;
      diagnostics: readonly [];
      runs: readonly RunReference[];
      summary: Readonly<{
        plannedCells: number;
        plannedRepeats: number;
        attempts: number;
        retriesPerformed: number;
        terminalVerdicts: Readonly<Record<RunVerdict, number>>;
        authorityCoverage: Readonly<{
          recordedRuns: number;
          totalRuns: number;
          judgeCompletedRuns: number;
          judgeRequiredRuns: number;
          comparableRuns: number;
          agreements: number;
          disagreements: number;
        }>;
        nonPasses: readonly RunReference[];
        omittedNonPasses: number;
      }>;
    }>;

export interface RunEngine {
  run(request: RunRequest): Promise<RunResult>;
}

export interface ExecutionProgressCell {
  readonly ordinal: number;
  readonly total: number;
  readonly taskId: string;
  readonly conditionId: string;
  readonly adapterId: string;
  readonly repeatOrdinal: number;
  readonly repeatTotal: number;
}

export type ExecutionProgressEvent =
  | Readonly<{ kind: "matrix-ready"; total: number }>
  | Readonly<{ kind: "cell-started" | "cell-finalizing"; cell: ExecutionProgressCell }>
  | Readonly<{ kind: "cell-attempt-started"; cell: ExecutionProgressCell; executionId: string }>
  | Readonly<{
      kind: "environment-status";
      executionId: string;
      environmentId: "together";
      status: "starting-guardian" | "guardian-started" | "starting-sandbox"
        | "sandbox-started" | "preparing-environment" | "preparing-workspace"
        | "agent-running" | "collecting-results" | "stopping-sandboxes";
    }>
  | Readonly<{
      kind: "environment-resource-allocated";
      executionId: string;
      environmentId: "together";
      resource: Readonly<{
        provider: "together";
        role: "guardian" | "agent";
        id: string;
      }>;
    }>
  | Readonly<{
      kind: "cell-completed";
      cell: ExecutionProgressCell;
      terminal: Readonly<{
        id: RunId;
        verdict: RunVerdict;
        verdictReasons: readonly Readonly<{ code: string; summary: string }>[];
        runTrustReasons?: readonly Readonly<{ code: string; summary: string }>[];
      }>;
    }>;

export interface ExecutionProgressObserver {
  observe(event: ExecutionProgressEvent): void;
}

export function createRunEngine(
  dependencies: Readonly<{
    resultStore: ResultStore;
    agentAdapter?: object;
    agentAdapters?: readonly object[];
    executionEnvironment: object;
    judge?: Judge | null;
    progressObserver?: ExecutionProgressObserver | null;
  }>,
): RunEngine;
