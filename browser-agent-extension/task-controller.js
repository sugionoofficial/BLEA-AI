// Small, deterministic safety state machine for future multi-step browser runs.
// A task starts in supervised mode; explicit user intent may opt into auto mode.
export function createTaskController({ autoRequested = false } = {}) {
  let state = autoRequested ? 'running_auto' : 'running_supervised';
  let stopRequested = false;
  let inFlight = false;

  return {
    get state() { return state; },
    get stopRequested() { return stopRequested; },
    get inFlight() { return inFlight; },
    canRun(action) {
      if (stopRequested || state === 'stopped' || state === 'completed') return false;
      if (inFlight) return false;
      if (state === 'running_auto') return true;
      return state === 'confirmed' && Boolean(action?.confirmed);
    },
    begin(action) {
      if (!this.canRun(action)) return false;
      inFlight = true;
      return true;
    },
    finishStep() {
      inFlight = false;
      if (stopRequested) state = 'stopped';
      else if (state === 'confirmed') state = 'running_supervised';
    },
    stop() {
      stopRequested = true;
      if (!inFlight) state = 'stopped';
      return state;
    },
    resume() {
      if (state !== 'stopped') return false;
      stopRequested = false;
      state = 'awaiting_confirmation';
      return true;
    },
    confirmNext() {
      if (state !== 'awaiting_confirmation' && state !== 'running_supervised') return false;
      state = 'confirmed';
      return true;
    },
    complete() {
      if (inFlight) return false;
      state = 'completed';
      return true;
    },
  };
}
