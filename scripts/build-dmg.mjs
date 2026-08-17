import { execSync } from 'node:child_process'
import { readFileSync, existsSync, rmSync, mkdirSync, copyFileSync, symlinkSync, readlinkSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const tauriConf = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))

const productName = tauriConf.productName || pkg.name
const version = tauriConf.version || pkg.version
const appName = `${productName}.app`
const dmgName = `${productName}_${version}_aarch64.dmg`

const bundleDir = path.join(root, 'src-tauri', 'target', 'release', 'bundle')
const appPath = path.join(bundleDir, 'macos', appName)
const dmgPath = path.join(bundleDir, dmgName)

const releaseDir = path.join(root, 'release')
const releaseAppPath = path.join(releaseDir, appName)
const releaseDmgPath = path.join(releaseDir, dmgName)

if (!existsSync(appPath)) {
  console.error(`App not found: ${appPath}`)
  console.error('Run "pnpm tauri build" first.')
  process.exit(1)
}

// ---- 图标修复 ----
console.log('🔧 修复 macOS 图标...')
try {
  execSync(`node "${path.join(__dirname, 'fix-mac-icon.mjs')}" "${appPath}"`, { stdio: 'inherit' })
} catch (e) {
  console.error('⚠️ 图标修复失败，继续打包...')
}

mkdirSync(releaseDir, { recursive: true })

// 清理 release 目录中旧的同名产物
for (const target of [releaseAppPath, releaseDmgPath]) {
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true })
  }
}

if (existsSync(dmgPath)) {
  rmSync(dmgPath)
}

const stageDir = path.join(os.tmpdir(), `dmg-stage-${productName}-${Date.now()}`)
mkdirSync(stageDir, { recursive: true })

try {
  // 把 .app 复制到暂存目录
  execSync(`ditto "${appPath}" "${path.join(stageDir, appName)}"`, { stdio: 'inherit' })

  // 创建指向系统 Applications 的软链接，Finder 打开 DMG 后会显示"拖到 Applications"入口
  const appsLink = path.join(stageDir, 'Applications')
  try {
    const target = readlinkSync('/Applications')
    symlinkSync(target, appsLink)
  } catch {
    symlinkSync('/Applications', appsLink)
  }

  const cmd = `hdiutil create -volname "${productName}" -srcfolder "${stageDir}" -ov -format UDZO "${dmgPath}"`
  console.log(`Running: ${cmd}`)
  execSync(cmd, { stdio: 'inherit' })
  console.log(`Created: ${dmgPath}`)

  // 将 .app 与 .dmg 复制到 release 目录
  console.log('Copying artifacts to release/ ...')
  copyFileSync(dmgPath, releaseDmgPath)
  execSync(`ditto "${appPath}" "${releaseAppPath}"`, { stdio: 'inherit' })
  console.log(`App copied to: ${releaseAppPath}`)
  console.log(`DMG copied to: ${releaseDmgPath}`)
} finally {
  // 清理暂存目录
  rmSync(stageDir, { recursive: true, force: true })
}
