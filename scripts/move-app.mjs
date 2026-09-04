#!/usr/bin/env node

import { existsSync, mkdirSync, cpSync, rmSync } from 'fs'
import { join, dirname, basename } from 'path'
import { fileURLToPath } from 'url'
import { findMacApp, parseTargetArg } from './mac-arch.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')
const target = parseTargetArg()

const releaseDir = join(rootDir, 'release')
if (!existsSync(releaseDir)) {
  mkdirSync(releaseDir, { recursive: true })
}

const appPath = findMacApp(rootDir, { target })
if (!appPath) {
  console.error(target ? `❌ 未找到 ${target} 的 .app 文件` : '❌ 未找到 .app 文件')
  process.exit(1)
}

const appFile = basename(appPath)
const dest = join(releaseDir, appFile)

if (existsSync(dest)) {
  rmSync(dest, { recursive: true, force: true })
}

cpSync(appPath, dest, { recursive: true })
console.log(`✅ 已复制: ${appFile} -> release/`)
console.log('\n🎉 构建完成！')
