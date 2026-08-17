#!/usr/bin/env node
/**
 * macOS 图标修复脚本
 *
 * 问题：Tauri 2.x 默认不生成 Asset Catalog，Info.plist 缺 CFBundleIconName，
 *       导致 macOS 11+ Launchpad 里图标偏大。
 *
 * 修复：
 *   路径 A（需要完整 Xcode）：actool 编译 Assets.car + 注入 CFBundleIconName
 *   路径 B（仅 Command Line Tools）：iconutil 重生成 .icns + 注入 CFBundleIconName
 *
 * 用法：node scripts/fix-mac-icon.mjs [appPath]
 *   不传 appPath 时自动查找 src-tauri/target/release/bundle/macos/*.app
 */

import { execSync } from 'node:child_process'
import {
  existsSync, mkdirSync, rmSync, copyFileSync, readdirSync,
  readFileSync, writeFileSync, mkdirSync as fsMkdir
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

// ---- 查找 .app ----
let appPath = process.argv[2]

if (!appPath) {
  const bundleDir = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos')
  if (!existsSync(bundleDir)) {
    // 也尝试 release 目录
    const releaseDir = path.join(root, 'release')
    if (existsSync(releaseDir)) {
      const apps = readdirSync(releaseDir).filter(f => f.endsWith('.app'))
      if (apps.length > 0) {
        appPath = path.join(releaseDir, apps[0])
      }
    }
  } else {
    const apps = readdirSync(bundleDir).filter(f => f.endsWith('.app'))
    if (apps.length > 0) {
      appPath = path.join(bundleDir, apps[0])
    }
  }
}

if (!appPath || !existsSync(appPath)) {
  console.error('❌ 未找到 .app，请先运行 tauri build')
  console.error('   用法: node scripts/fix-mac-icon.mjs [appPath]')
  process.exit(1)
}

console.log(`📦 修复图标: ${appPath}`)

const resourcesDir = path.join(appPath, 'Contents', 'Resources')
const plistPath = path.join(appPath, 'Contents', 'Info.plist')
const icnsPath = path.join(resourcesDir, 'icon.icns')

// 源图标（1024x1024）
const sourceIcon = path.join(root, 'build', 'icon-1024.png')

if (!existsSync(sourceIcon)) {
  console.error(`❌ 源图标不存在: ${sourceIcon}`)
  process.exit(1)
}

// ---- 工具函数 ----
function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'pipe', encoding: 'utf8', ...opts })
}

function runInherit(cmd) {
  execSync(cmd, { stdio: 'inherit' })
}

function hasTool(name) {
  try {
    execSync(`which ${name}`, { stdio: 'pipe', encoding: 'utf8' })
    return true
  } catch {
    return false
  }
}

function plistGet(key) {
  try {
    return run(`/usr/libexec/PlistBuddy -c "Print :${key}" "${plistPath}" 2>/dev/null`).trim()
  } catch {
    return null
  }
}

function plistSet(key, value) {
  try {
    run(`/usr/libexec/PlistBuddy -c "Set :${key} ${value}" "${plistPath}"`)
  } catch {
    run(`/usr/libexec/PlistBuddy -c "Add :${key} string ${value}" "${plistPath}"`)
  }
}

// ---- Step 1: 去除源图透明度（铺白底）----
const tmpDir = path.join('/tmp', `mac-icon-fix-${Date.now()}`)
mkdirSync(tmpDir, { recursive: true })

const opaqueIcon = path.join(tmpDir, 'icon-opaque-1024.png')
console.log('🎨 去除图标透明度...')

// 方案 1: 用 Python PIL 去除透明度（铺白底）
let alphaRemoved = false
try {
  const pythonScript = `
from PIL import Image
img = Image.open('${sourceIcon}').convert('RGBA')
bg = Image.new('RGBA', img.size, (255, 255, 255, 255))
bg.paste(img, mask=img.split()[3] if img.mode == 'RGBA' else None)
bg.convert('RGB').save('${opaqueIcon}', 'PNG')
print('OK')
`
  const result = execSync(`python3 -c "${pythonScript.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8', stdio: 'pipe'
  }).trim()
  if (result === 'OK' && existsSync(opaqueIcon)) {
    alphaRemoved = true
    console.log('  (PIL 去除透明度成功)')
  }
} catch {
  // PIL 不可用
}

// 方案 2: 用 sips 去除透明度（不同写法）
if (!alphaRemoved) {
  try {
    // sips 没有 hasAlpha，用 format png + flatten 的替代方式
    // 先转 jpeg 去掉 alpha，再转回 png
    const tmpJpg = path.join(tmpDir, 'tmp.jpg')
    execSync(`sips -s format jpeg "${sourceIcon}" --out "${tmpJpg}"`, { stdio: 'pipe' })
    execSync(`sips -s format png "${tmpJpg}" --out "${opaqueIcon}"`, { stdio: 'pipe' })
    if (existsSync(opaqueIcon)) {
      alphaRemoved = true
      console.log('  (sips jpeg 中转去除透明度成功)')
    }
  } catch {
    // sips 方式也失败
  }
}

// 方案 3: 直接用原图（可能有透明度，但 iconutil 仍能处理）
if (!alphaRemoved) {
  console.log('  ⚠️ 无法去除透明度，使用原始图标')
  copyFileSync(sourceIcon, opaqueIcon)
}

// ---- Step 2: 生成 iconset ----
const iconsetDir = path.join(tmpDir, 'AppIcon.iconset')
mkdirSync(iconsetDir, { recursive: true })

console.log('📐 生成各分辨率图标...')
const sizes = [
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

for (const [name, size] of sizes) {
  runInherit(`sips -z ${size} ${size} "${opaqueIcon}" --out "${path.join(iconsetDir, name)}"`)
}

// ---- Step 3: 检查是否有 actool（完整 Xcode）----
const hasActool = hasTool('actool')

if (hasActool) {
  console.log('✅ 检测到 actool（完整 Xcode），走路径 A：编译 Assets.car')

  // 创建 Assets.xcassets 结构
  const xcassetsDir = path.join(tmpDir, 'Assets.xcassets')
  const appIconSetDir = path.join(xcassetsDir, 'AppIcon.appiconset')
  mkdirSync(appIconSetDir, { recursive: true })

  // Contents.json
  const contentsJson = {
    "images": [
      { "filename": "icon_16x16.png", "idiom": "mac", "scale": "1x", "size": "16x16" },
      { "filename": "icon_16x16@2x.png", "idiom": "mac", "scale": "2x", "size": "16x16" },
      { "filename": "icon_32x32.png", "idiom": "mac", "scale": "1x", "size": "32x32" },
      { "filename": "icon_32x32@2x.png", "idiom": "mac", "scale": "2x", "size": "32x32" },
      { "filename": "icon_128x128.png", "idiom": "mac", "scale": "1x", "size": "128x128" },
      { "filename": "icon_128x128@2x.png", "idiom": "mac", "scale": "2x", "size": "128x128" },
      { "filename": "icon_256x256.png", "idiom": "mac", "scale": "1x", "size": "256x256" },
      { "filename": "icon_256x256@2x.png", "idiom": "mac", "scale": "2x", "size": "256x256" },
      { "filename": "icon_512x512.png", "idiom": "mac", "scale": "1x", "size": "512x512" },
      { "filename": "icon_512x512@2x.png", "idiom": "mac", "scale": "2x", "size": "512x512" }
    ],
    "info": { "author": "xcode", "version": 1 }
  }

  writeFileSync(path.join(appIconSetDir, 'Contents.json'), JSON.stringify(contentsJson, null, 2))

  // 复制图标文件
  for (const [name] of sizes) {
    copyFileSync(path.join(iconsetDir, name), path.join(appIconSetDir, name))
  }

  // 编译 Assets.car
  console.log('🔨 编译 Assets.car...')
  try {
    runInherit(
      `xcrun actool --compile "${resourcesDir}" ` +
      `--app-icon "AppIcon" ` +
      `--output-partial-info-plist "${path.join(tmpDir, 'partial-info.plist')}" ` +
      `--target-device mac ` +
      `--minimum-deployment-target 10.13 ` +
      `--platform macosx ` +
      `"${xcassetsDir}"`
    )
    console.log('✅ Assets.car 已生成')
  } catch (e) {
    console.error('⚠️ actool 编译失败，回退到路径 B')
    fixWithIconutil()
  }
} else {
  console.log('⚠️ 未检测到 actool（需要完整 Xcode），走路径 B：iconutil 重生成 .icns')
  fixWithIconutil()
}

function fixWithIconutil() {
  // 用 iconutil 重新生成 .icns
  const newIcns = path.join(tmpDir, 'icon.icns')
  console.log('🔨 用 iconutil 重新生成 .icns...')
  runInherit(`iconutil -c icns "${iconsetDir}" --output "${newIcns}"`)

  if (!existsSync(newIcns)) {
    console.error('❌ iconutil 生成失败')
    process.exit(1)
  }

  // 替换 bundle 中的 .icns
  if (existsSync(icnsPath)) {
    rmSync(icnsPath)
  }
  copyFileSync(newIcns, icnsPath)
  console.log(`✅ icon.icns 已更新 (${(readFileSync(newIcns).length / 1024).toFixed(0)}KB)`)
}

// ---- Step 4: 注入 CFBundleIconName ----
console.log('📝 注入 CFBundleIconName 到 Info.plist...')
const currentIconName = plistGet('CFBundleIconName')
if (!currentIconName) {
  plistSet('CFBundleIconName', 'AppIcon')
  console.log('✅ CFBundleIconName = AppIcon 已注入')
} else {
  console.log(`ℹ️ CFBundleIconName 已存在: ${currentIconName}`)
}

// 确认 CFBundleIconFile 也在
const currentIconFile = plistGet('CFBundleIconFile')
if (!currentIconFile) {
  plistSet('CFBundleIconFile', 'icon')
  console.log('✅ CFBundleIconFile = icon 已注入')
} else {
  console.log(`ℹ️ CFBundleIconFile 已存在: ${currentIconFile}`)
}

// ---- 清理 ----
rmSync(tmpDir, { recursive: true, force: true })

console.log('\n🎉 图标修复完成！')
console.log('   提示：安装后如仍显示旧图标，请重置 Launchpad 缓存：')
console.log('   rm -rf ~/Library/Application\\ Support/com.apple.dock.launchpad/db && killall Dock')
