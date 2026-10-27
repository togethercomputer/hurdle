import { ThemeToggle } from "./ThemeToggle";
import { TogetherCredit } from "./TogetherCredit";

// Shared by the app rail and the transcript rail. The rails sit on the app
// chrome, so the footer needs no dividing border; px-5 lines its content up
// with the brand and the rail rows above it.
export function SidebarFooter() {
  return (
    <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-5 py-4">
      <TogetherCredit />
      <ThemeToggle />
    </footer>
  );
}
