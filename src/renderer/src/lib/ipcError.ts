export function formatIpcError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  return message.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
}
