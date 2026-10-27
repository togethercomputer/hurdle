"use client";

import type { ReactNode } from "react";
import { useShowAgentTraffic } from "@/lib/use-show-agent-traffic";

// Renders its children only when "Show agent traffic" is on in Viewer settings.
export function AgentTrafficGate({ children }: { children: ReactNode }) {
  const [show] = useShowAgentTraffic();
  return show ? <>{children}</> : null;
}
