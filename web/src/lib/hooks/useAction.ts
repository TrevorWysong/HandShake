// Something a person sets off with a tap -- saving, accepting, cancelling --
// and what the screen shows of it: a spinner while it runs, and why it
// failed. One place for the dance every button otherwise repeats (busy on,
// error cleared, run, error kept, busy off), so no copy of it forgets a
// step -- and a second tap while it's running does nothing, so nothing is
// sent twice.
import { useRef, useState } from "react";
import { describeError } from "../ui/errors";

export interface Action {
  /// Whether it's running -- for its button's spinner.
  busy: boolean;
  /// What's running, by the name it was run `as` -- for a screen of steps on
  /// one thing (an order's cancel, confirm, review), each its own button,
  /// none run while another is.
  doing: string | null;
  /// Why it last failed, worded for the person; cleared when it runs again.
  error: string | null;
  /// Runs `work` unless it's already running: busy while it does, a failure
  /// kept as `error`. Resolves whether it succeeded. `stayBusy` keeps it busy
  /// once it has -- for a step the screen moves on from, so nothing can send
  /// it again in the moment before it does.
  run: (work: () => Promise<unknown>, options?: { as?: string; stayBusy?: boolean }) => Promise<boolean>;
  /// Clears `error`, or sets one the screen worked out itself.
  setError: (error: string | null) => void;
}

export function useAction(): Action {
  const [doing, setDoing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Read in the handler itself: state wouldn't show a tap made before the
  // first one re-rendered.
  const running = useRef(false);

  async function run(work: () => Promise<unknown>, { as = "", stayBusy = false }: { as?: string; stayBusy?: boolean } = {}): Promise<boolean> {
    if (running.current) return false;
    running.current = true;
    setDoing(as);
    setError(null);
    try {
      await work();
      if (!stayBusy) done();
      return true;
    } catch (err) {
      setError(describeError(err));
      done();
      return false;
    }
  }

  function done() {
    running.current = false;
    setDoing(null);
  }

  return { busy: doing !== null, doing, error, run, setError };
}
