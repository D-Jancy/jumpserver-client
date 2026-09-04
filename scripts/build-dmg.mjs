import { execSync } from 'node:child_process'
import { readFileSync, existsSync, rmSync, mkdirSync, copyFileSync, symlinkSync, readlinkSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { bundleDir, detectDmgArchSuffix, findMacApp, parseTargetArg } from './mac-arch.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const target = parseTargetArg()

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const tauriConf = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))

const productName = tauriConf.productName || pkg.name
const version = tauriConf.version || pkg.version
const appName = `${productName}.app`

const appPath = findMacApp(root, { target, appName })
if (!appPath) {
  console.error(target
    ? `App not found for target ${target}`
    : `App not found: ${appName}`)
  console.error('Run "pnpm tauri build --bundles app" first.')
  console.error('Intel 包请使用: pnpm build:mac:intel')
  process.exit(1)
}

const archSuffix = detectDmgArchSuffix(appPath, productName, target)
const dmgName = `${productName}_${version}_${archSuffix}.dmg`
const appParentDir = path.dirname(appPath)
const outputBundleDir = path.basename(appParentDir) === 'macos'
  ? path.dirname(appParentDir)
  : bundleDir(root, target)
const dmgPath = path.join(outputBundleDir, dmgName)

const releaseDir = path.join(root, 'release')
const releaseAppPath = path.join(releaseDir, appName)
const releaseDmgPath = path.join(releaseDir, dmgName)

console.log(`📦 App: ${appPath}`)
console.log(`🧱 Arch: ${archSuffix}`)

console.log('🔧 修复 macOS 图标...')
try {
  execSync(`node "${path.join(__dirname, 'fix-mac-icon.mjs')}" "${appPath}"`, { stdio: 'inherit' })
} catch {
  console.error('⚠️ 图标修复失败，继续打包...')
}

mkdirSync(releaseDir, { recursive: true })
mkdirSync(outputBundleDir, { recursive: true })

for (const artifact of [releaseAppPath, releaseDmgPath, dmgPath]) {
  if (existsSync(artifact)) {
    rmSync(artifact, { recursive: true, force: true })
  }
}

const stageDir = path.join(os.tmpdir(), `dmg-stage-${productName}-${archSuffix}-${Date.now()}`)
mkdirSync(stageDir, { recursive: true })

try {
  execSync(`ditto "${appPath}" "${path.join(stageDir, appName)}"`, { stdio: 'inherit' })

  const appsLink = path.join(stageDir, 'Applications')
  try {
    const linkTarget = readlinkSync('/Applications')
    symlinkSync(linkTarget, appsLink)
  } catch {
    symlinkSync('/Applications', appsLink)
  }

  const cmd = `hdiutil create -volname "${productName}" -srcfolder "${stageDir}" -ov -format UDZO "${dmgPath}"`
  console.log(`Running: ${cmd}`)
  execSync(cmd, { stdio: 'inherit' })
  console.log(`Created: ${dmgPath}`)

  console.log('Copying artifacts to release/ ...')
  copyFileSync(dmgPath, releaseDmgPath)
  execSync(`ditto "${appPath}" "${releaseAppPath}"`, { stdio: 'inherit' })
  console.log(`App copied to: ${releaseAppPath}`)
  console.log(`DMG copied to: ${releaseDmgPath}`)
} finally {
  rmSync(stageDir, { recursive: true, force: true })
}
