#!/usr/bin/env node
/**
 * 从 docs/icon.svg 生成 macOS Dock 用图标：
 *   - 去掉米色/白色底板，保留透明背景
 *   - 按 Apple 824/1024 安全区缩放，避免 Dock / Launchpad 里偏大一圈
 *
 * 用法: node scripts/generate-icons.mjs
 */

import { execSync } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const svgPath = path.join(root, 'docs', 'icon.svg')
const buildDir = path.join(root, 'build')
const tauriIcons = path.join(root, 'src-tauri', 'icons')
const swiftScript = path.join(__dirname, 'render-mac-icon.swift')

const BACKGROUND_PATH =
  '<path d="M0 0 C244.2 0 488.4 0 740 0 C740 244.2 740 488.4 740 740 C495.8 740 251.6 740 0 740 C0 495.8 0 251.6 0 0 Z " fill="#F8F7F5" transform="translate(0,0)"/>'

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', ...opts })
}

if (!existsSync(svgPath)) {
  console.error(`❌ 源 SVG 不存在: ${svgPath}`)
  process.exit(1)
}

let svg = readFileSync(svgPath, 'utf8')
if (!svg.includes(BACKGROUND_PATH)) {
  console.error('❌ 未找到米色底板 path，拒绝继续以免生成错误图标')
  process.exit(1)
}
svg = svg.replace(BACKGROUND_PATH, '')
svg = svg.replace(
  '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="740" height="740">',
  '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="740" height="740" viewBox="0 0 740 740">',
)

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'jsc-icons-'))
const tmpSvg = path.join(tmpDir, 'icon-nobg.svg')
const masterPng = path.join(buildDir, 'icon-1024.png')

try {
  writeFileSync(tmpSvg, svg)
  mkdirSync(buildDir, { recursive: true })

  console.log('🎨 渲染透明背景 + Dock 安全区图标...')
  run(`swift "${swiftScript}" "${tmpSvg}" "${masterPng}"`)

  const pngSizes = [16, 32, 48, 64, 128, 256, 512]
  console.log('📐 生成各尺寸 PNG...')
  for (const size of pngSizes) {
    run(`sips -z ${size} ${size} "${masterPng}" --out "${path.join(buildDir, `icon-${size}.png`)}"`)
  }
  copyFileSync(path.join(buildDir, 'icon-256.png'), path.join(buildDir, 'icon.png'))

  const iconset = path.join(tmpDir, 'icon.iconset')
  mkdirSync(iconset)
  const icnsSizes = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024],
  ]
  for (const [name, size] of icnsSizes) {
    run(`sips -z ${size} ${size} "${masterPng}" --out "${path.join(iconset, name)}"`)
  }
  const buildIcns = path.join(buildDir, 'icon.icns')
  console.log('🍎 生成 icon.icns...')
  run(`iconutil -c icns "${iconset}" --output "${buildIcns}"`)

  console.log('📦 生成 src-tauri/icons（含 .ico）...')
  run(`pnpm tauri icon "${masterPng}" -o "${tauriIcons}"`)
  copyFileSync(buildIcns, path.join(tauriIcons, 'icon.icns'))
  copyFileSync(path.join(tauriIcons, 'icon.ico'), path.join(buildDir, 'icon.ico'))

  // tauri icon 会顺带生成 iOS / Android / Appx 资源，本项目只用 macOS + Windows
  const extras = [
    'android', 'ios',
    '64x64.png', 'StoreLogo.png',
    'Square30x30Logo.png', 'Square44x44Logo.png', 'Square71x71Logo.png',
    'Square89x89Logo.png', 'Square107x107Logo.png', 'Square142x142Logo.png',
    'Square150x150Logo.png', 'Square284x284Logo.png', 'Square310x310Logo.png',
  ]
  for (const name of extras) {
    const p = path.join(tauriIcons, name)
    if (existsSync(p)) rmSync(p, { recursive: true, force: true })
  }

  console.log('\n🎉 图标已更新')
  console.log(`   ${masterPng}`)
  console.log(`   ${tauriIcons}`)
} finally {
  rmSync(tmpDir, { recursive: true, force: true })
}
