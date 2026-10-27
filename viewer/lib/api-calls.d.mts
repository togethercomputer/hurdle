export type ApiCallScope = "task" | "agent";
export type ApiCallRow = { scope?: ApiCallScope; status?: number; disposition?: "blocked" };
export function taskApiHosts(snapshot: unknown): Set<string> | null;
export function apiCallScope(host: string, taskHosts: Set<string> | null): ApiCallScope;
export function splitApiCalls<T extends ApiCallRow>(rows: T[]): { task: T[]; agent: T[] };
export function isOkStatus(status: number | undefined): boolean;
export function summarizeApiCalls(rows: ApiCallRow[]): { calls: number; blocked: number; failed: number };
