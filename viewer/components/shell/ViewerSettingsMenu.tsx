"use client";

import { Menu } from "@base-ui/react/menu";
import { Check, Settings } from "lucide-react";
import { useShowAgentTraffic } from "@/lib/use-show-agent-traffic";

// Per-browser Viewer settings, next to the theme switch.
export function ViewerSettingsMenu() {
  const [showAgentTraffic, setShowAgentTraffic] = useShowAgentTraffic();
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="Viewer settings"
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-rule bg-background text-fg-faint transition-colors hover:text-foreground data-[popup-open]:text-foreground"
      >
        <Settings className="h-3 w-3" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="end" side="top" className="z-50 outline-none">
          <Menu.Popup className="w-64 rounded-xl border border-rule bg-background p-1 shadow-xs outline-none">
            <Menu.Group>
              <Menu.GroupLabel className="px-3 pt-1.5 pb-1 text-[11px] font-medium text-fg-faint">Viewer settings</Menu.GroupLabel>
              <Menu.CheckboxItem
                checked={showAgentTraffic}
                onCheckedChange={setShowAgentTraffic}
                closeOnClick={false}
                className="flex w-full cursor-default select-none items-start gap-2 rounded-md px-3 py-1.5 text-left outline-none data-[highlighted]:bg-surface"
              >
                <span className="mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border border-rule">
                  <Menu.CheckboxItemIndicator>
                    <Check className="h-3 w-3 text-foreground" aria-hidden />
                  </Menu.CheckboxItemIndicator>
                </span>
                <span className="flex flex-col">
                  <span className="text-[12px] text-foreground">Show agent traffic</span>
                  <span className="text-[11px] text-fg-muted">
                    List the Agent&apos;s own model, config and telemetry calls under a run&apos;s captured API calls.
                  </span>
                </span>
              </Menu.CheckboxItem>
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
