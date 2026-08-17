#!/usr/bin/env node

import { existsSync, mkdirSync, cpSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')

const bundleDir = join(rootDir, 'src-tauri/target/release/bundle/macos')
const releaseDir = join(rootDir, 'release')

// 确保 release 目录存在
if (!existsSync(releaseDir)) {
  mkdirSync(releaseDir, { recursive: true })
}

// 查找 .app 文件
const appFiles = existsSync(bundleDir) 
  ? (await import('fs')).readdirSync(bundleDir).filter(f => f.endsWith('.app'))
  : []

if (appFiles.length === 0) {
  console.error('❌ 未找到 .app 文件')
  process.exit(1)
}

// 复制到 release 目录
for (const appFile of appFiles) {
  const src = join(bundleDir, appFile)
  const dest = join(releaseDir, appFile)
  
  // 如果目标已存在，先删除
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true })
  }
  
  cpSync(src, dest, { recursive: true })
  console.log(`✅ 已复制: ${appFile} -> release/`)
}

console.log('\n🎉 构建完成！')
