export type ApiCallRow = { status?: number; disposition?: "blocked" };
export function taskApiHosts(snapshot: unknown): Set<string> | null;
export function isTaskApiCall(host: string, taskHosts: Set<string> | null): boolean;
export function isOkStatus(status: number | undefined): boolean;
export function summarizeApiCalls(rows: ApiCallRow[]): { calls: number; blocked: number; failed: number };
