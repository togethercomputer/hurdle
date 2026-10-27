type SettingsStorage = Pick<Storage, "getItem" | "setItem">;
export const SHOW_AGENT_TRAFFIC_KEY: string;
export function readShowAgentTraffic(storage: SettingsStorage): boolean;
export function writeShowAgentTraffic(storage: SettingsStorage, show: boolean, target?: EventTarget): void;
export function subscribeViewerSettings(target: EventTarget, onChange: () => void): () => void;
