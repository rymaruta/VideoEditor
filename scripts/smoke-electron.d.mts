// smoke-electron.mjs の型(試験から読むため)
export function expectedPackagedFiles(platform: string, arch: string): string[]
export function updateConfigProblems(build: string | undefined, text: string | null): string[]
export function envCheckProblems(result: unknown, platform: string): string[]
export function probeProblems(probe: unknown): string[]
