import { execSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

export const MAC_RUST_TARGETS = [
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'universal-apple-darwin',
]

const TARGET_ALIASES = {
  intel: 'x86_64-apple-darwin',
  x64: 'x86_64-apple-darwin',
  x86_64: 'x86_64-apple-darwin',
  arm: 'aarch64-apple-darwin',
  arm64: 'aarch64-apple-darwin',
  aarch64: 'aarch64-apple-darwin',
  universal: 'universal-apple-darwin',
}

const TARGET_DMG_SUFFIX = {
  'aarch64-apple-darwin': 'aarch64',
  'x86_64-apple-darwin': 'x64',
  'universal-apple-darwin': 'universal',
}

export function normalizeTarget(value) {
  if (!value) return ''
  return TARGET_ALIASES[value] || value
}

export function parseTargetArg(argv = process.argv.slice(2), env = process.env) {
  let target = env.TAURI_TARGET || env.CARGO_BUILD_TARGET || ''
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--target' && argv[i + 1]) {
      target = argv[++i]
      continue
    }
    if (arg.startsWith('--target=')) {
      target = arg.slice('--target='.length)
    }
  }
  return normalizeTarget(target)
}

export function dmgArchSuffixFromTarget(target) {
  return TARGET_DMG_SUFFIX[normalizeTarget(target)] || ''
}

export function bundleMacosDir(root, target = '') {
  if (target) {
    return path.join(root, 'src-tauri', 'target', target, 'release', 'bundle', 'macos')
  }
  return path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos')
}

export function bundleDir(root, target = '') {
  return path.dirname(bundleMacosDir(root, target))
}

function listMacApps(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.app'))
    .map((name) => path.join(dir, name))
}

export function findMacApp(root, { target = '', appName = '' } = {}) {
  const dirs = []
  if (target) {
    dirs.push(bundleMacosDir(root, target))
  } else {
    dirs.push(bundleMacosDir(root, ''))
    for (const rustTarget of MAC_RUST_TARGETS) {
      dirs.push(bundleMacosDir(root, rustTarget))
    }
    dirs.push(path.join(root, 'release'))
  }

  const seen = new Set()
  for (const dir of dirs) {
    if (seen.has(dir)) continue
    seen.add(dir)
    const apps = listMacApps(dir)
    if (appName) {
      const match = apps.find((appPath) => path.basename(appPath) === appName)
      if (match) return match
      continue
    }
    if (apps.length > 0) return apps[0]
  }
  return ''
}

export function detectDmgArchSuffix(appPath, productName, target = '') {
  const binaryPath = path.join(appPath, 'Contents', 'MacOS', productName)
  let archs = []
  try {
    archs = execSync(`lipo -archs "${binaryPath}"`, { encoding: 'utf8' })
      .trim()
      .split(/\s+/)
      .filter(Boolean)
  } catch {
    try {
      const info = execSync(`file "${binaryPath}"`, { encoding: 'utf8' })
      if (/arm64|aarch64/i.test(info) && /x86_64/i.test(info)) return 'universal'
      if (/arm64|aarch64/i.test(info)) return 'aarch64'
      if (/x86_64/i.test(info)) return 'x64'
    } catch {
      // ignore
    }
  }

  const hasArm = archs.includes('arm64') || archs.includes('aarch64')
  const hasX64 = archs.includes('x86_64')
  if (hasArm && hasX64) return 'universal'
  if (hasArm) return 'aarch64'
  if (hasX64) return 'x64'

  return dmgArchSuffixFromTarget(target) || (process.arch === 'arm64' ? 'aarch64' : 'x64')
}
