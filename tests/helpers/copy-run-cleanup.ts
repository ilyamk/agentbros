/** Only the test-owned operation/browser. No renderer patch or error suppression. */
export type CopyOperationState = "idle" | "active" | "normal" | "failed";
export async function cleanupCopyRun(input: {
  state: CopyOperationState;
  cancel: () => void;
  close: () => Promise<void>;
  pending: () => Promise<void>;
  persist: (errors: string[]) => void;
  remove: () => void;
}) {
  const errors: string[] = [];
  const record = (error: unknown) => errors.push(String(error));
  try {
    if (input.state === "active" || input.state === "failed")
      try {
        input.cancel();
      } catch (error) {
        record(error);
      }
    try {
      await input.close();
    } catch (error) {
      record(error);
    }
    try {
      await input.pending();
    } catch (error) {
      record(error);
    }
  } finally {
    try {
      input.persist(errors);
    } catch (error) {
      record(error);
    } finally {
      try {
        input.remove();
      } catch (error) {
        record(error);
      }
    }
  }
  return errors;
}
