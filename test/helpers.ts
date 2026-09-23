/** Runs `fn` and returns what it threw; fails the test when nothing was thrown. */
export function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the function to throw');
}
