/**
 * Collapses a burst of calls into one deferred run.
 *
 * Built on setTimeout rather than setImmediate or a Node timer: the mobile
 * WebView has neither, and scripts/check-mobile-globals.mjs fails the build
 * when one reaches the bundle.
 */
export interface DebouncedRunner {
  /** Run once, `delayMs` after the last call. */
  schedule(): void;
  /** Forget what is pending without running it. */
  cancel(): void;
}

export function createDebouncedRunner(
  run: () => void,
  delayMs: number
): DebouncedRunner {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    schedule(): void {
      clear();
      timer = setTimeout(() => {
        timer = null;
        run();
      }, delayMs);
    },
    cancel(): void {
      clear();
    },
  };
}
