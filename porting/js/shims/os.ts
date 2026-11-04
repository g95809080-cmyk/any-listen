/** `node:os` 替身 —— 环境信息全部来自 `FileSystemPort.getEnv()`（见 shims/fs 与 ports）。 */

let cachedTmpDir = '/data/local/tmp'

export function setTmpDir(dir: string): void {
  cachedTmpDir = dir
}

export function tmpdir(): string {
  return cachedTmpDir
}

export function platform(): string {
  return 'android'
}

export function arch(): string {
  return 'arm64'
}

export function release(): string {
  return '0'
}

export function type(): string {
  return 'Android'
}

export function hostname(): string {
  return 'localhost'
}

export function homedir(): string {
  return '/data/data'
}

export function cpus(): Array<{ model: string; speed: number }> {
  const count = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4
  return Array.from({ length: count }, () => ({ model: 'unknown', speed: 0 }))
}

export function totalmem(): number {
  const deviceMemory = (navigator as { deviceMemory?: number }).deviceMemory
  return (deviceMemory ?? 4) * 1024 * 1024 * 1024
}

export default { tmpdir, platform, arch, release, type, hostname, homedir, cpus, totalmem, setTmpDir }
