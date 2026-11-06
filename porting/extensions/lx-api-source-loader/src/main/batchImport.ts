export class DuplicateScriptError extends Error {}

export interface ImportResult {
  added: number
  duplicates: Array<{ name: string; message: string }>
  failures: Array<{ name: string; message: string }>
}

/** 每个文件独立读取和写入；一个文件失败不影响本批后续文件。 */
export async function importFiles(
  paths: string[],
  read: (path: string) => Promise<string>,
  add: (name: string, content: string) => Promise<void>,
  result: ImportResult = { added: 0, duplicates: [], failures: [] },
): Promise<ImportResult> {
  for (const path of paths) {
    const name = path.split(/[/\\]/).pop() ?? path
    try {
      await add(name, await read(path))
      result.added++
    } catch (error) {
      const item = { name, message: error instanceof Error ? error.message : String(error) }
      if (error instanceof DuplicateScriptError) result.duplicates.push(item)
      else result.failures.push(item)
    }
  }
  return result
}
