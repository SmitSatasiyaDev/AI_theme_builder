/** Human-readable message for any thrown value — `catch` bindings are `unknown`. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
