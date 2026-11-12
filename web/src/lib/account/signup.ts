// Signing up is a few steps -- the account and its profile, then a home
// address, then a driver's vehicle -- each a write of its own. One failing
// partway leaves the ones before it done: tried again, sign-up carries on
// from the step that failed, never from the start. So a sign-up whose
// vehicle didn't save, tried again, is one account with one profile.
// (`create_profile` is safe to repeat too, and validation refuses a
// second profile: the same holds for a sign-up cut short by a reload.)

/// One step: its name, and the write.
export interface SignupStep {
  name: "account" | "address" | "vehicle";
  run: () => Promise<void>;
}

/// Runs each of `steps` not already in `done`, in order, adding each to it
/// as it succeeds. A failure is thrown, with the steps before it kept done.
export async function completeSignup(steps: readonly SignupStep[], done: Set<SignupStep["name"]>): Promise<void> {
  for (const step of steps) {
    if (done.has(step.name)) continue;
    await step.run();
    done.add(step.name);
  }
}
