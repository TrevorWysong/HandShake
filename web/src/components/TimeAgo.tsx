import { useClock } from "../lib/hooks/useClock";
import { timeAgo } from "../lib/ui/format";

/// How long ago `at` (a Holochain timestamp) was, kept current as the
/// minutes pass.
export function TimeAgo({ at }: { at: number }) {
  return <>{timeAgo(at, useClock())}</>;
}
