import { cp, mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import config from './config.ts'

const root = path.dirname(fileURLToPath(import.meta.url))
const output = path.resolve(root, '../../../artifacts/lx-loader')
const stage = path.join(output, 'stage')
await mkdir(stage, { recursive: true })

for (const [entry, name] of [
  ['src/main/index.ts', 'main.js'],
  ['src/isolate-preload/index.ts', 'resources/isolate-preload.js'],
]) {
  await build({
    configFile: false,
    root,
    publicDir: false,
    resolve: { alias: { '@': path.join(root, 'src') } },
    build: {
      target: 'esnext', outDir: stage, emptyOutDir: false, minify: false,
      rollupOptions: {
        input: path.join(root, entry), external: ['any-listen'],
        output: { entryFileNames: name, format: 'iife', inlineDynamicImports: true },
      },
    },
  })
}

await cp(path.join(root, 'resources'), path.join(stage, 'resources'), { recursive: true })
await cp(path.join(root, 'i18n'), path.join(stage, 'i18n'), { recursive: true })
await cp(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'))
const { id, name, description, icon, version, target_engine, author, homepage, license, categories, tags, grant, contributes } = config
await writeFile(path.join(stage, 'manifest.json'), JSON.stringify({
  id, name, description, icon, version, target_engine, author, homepage, license, categories, tags, grant, contributes, main: 'main.js',
}, null, 2))

// 本地安装包不冒用上游签名；独立 ID 避免覆盖已安装的官方扩展。
const archive = path.join(output, `${id}_${version}.alix`)
execFileSync('tar', ['-czf', archive, '-C', stage, 'manifest.json', 'main.js', 'resources', 'i18n', 'LICENSE'], { stdio: 'inherit' })
console.log(`扩展安装包: ${archive}`)
