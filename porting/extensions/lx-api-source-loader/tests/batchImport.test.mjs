import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DuplicateScriptError, importFiles } from '../src/main/batchImport.ts'

test('逐文件隔离读取、解析和重复错误，并继续导入后续文件', async () => {
  const added = []
  const result = await importFiles(
    ['content://first.js', 'content://unreadable.js', 'content://duplicate.js', 'content://invalid.js', 'content://last.js'],
    async (path) => {
      if (path.endsWith('unreadable.js')) throw new Error('read failed')
      return path
    },
    async (name) => {
      if (name === 'duplicate.js') throw new DuplicateScriptError('already imported')
      if (name === 'invalid.js') throw new Error('invalid header')
      added.push(name)
    },
  )
  assert.deepEqual(added, ['first.js', 'last.js'])
  assert.equal(result.added, 2)
  assert.deepEqual(result.duplicates.map((item) => item.name), ['duplicate.js'])
  assert.deepEqual(result.failures.map((item) => item.message), ['read failed', 'invalid header'])

  const continued = await importFiles(['content://next.js'], async () => 'source', async () => {}, result)
  assert.equal(continued.added, 3)
  assert.equal(continued.failures.length, 2)
})
