import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { signApp } from '@electron/osx-sign'
import electronExecutable from 'electron'

if (process.platform !== 'darwin') process.exit(0)

const appBundle = dirname(dirname(dirname(electronExecutable)))
const infoPlist = join(appBundle, 'Contents', 'Info.plist')
const projectRoot = resolve(import.meta.dirname, '..')
const entitlements = join(projectRoot, 'resources', 'entitlements.mac.plist')
const developmentBundleId = 'ai.thinkany.douchat.dev'
const developmentAppName = 'Foundry Dev'
const launchServicesRegister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const microphoneUsageDescription = 'Foundry uses the microphone only for voice typing. / Foundry 仅在语音输入时使用麦克风。'
const speechRecognitionUsageDescription = 'Foundry converts your speech into message text only while voice input is active. / Foundry 仅在语音输入期间将你的语音转换为消息文字。'
const downloadsUsageDescription = 'Foundry accesses Downloads only when you ask an agent to find or open a local file. / Foundry 仅在你要求智能体查找或打开本地文件时访问下载文件夹。'
const desktopUsageDescription = 'Foundry accesses Desktop only when you ask an agent to find or open a local file. / Foundry 仅在你要求智能体查找或打开本地文件时访问桌面文件夹。'
const documentsUsageDescription = 'Foundry accesses Documents only when you ask an agent to find or open a local file. / Foundry 仅在你要求智能体查找或打开本地文件时访问文稿文件夹。'
const helperBundles = [
  { directory: 'Electron Helper.app', bundleId: `${developmentBundleId}.helper`, name: 'Foundry Helper' },
  { directory: 'Electron Helper (Renderer).app', bundleId: `${developmentBundleId}.helper.Renderer`, name: 'Foundry Helper (Renderer)' },
  { directory: 'Electron Helper (GPU).app', bundleId: `${developmentBundleId}.helper.GPU`, name: 'Foundry Helper (GPU)' },
  { directory: 'Electron Helper (Plugin).app', bundleId: `${developmentBundleId}.helper.Plugin`, name: 'Foundry Helper (Plugin)' }
].map((helper) => ({
  ...helper,
  infoPlist: join(appBundle, 'Contents', 'Frameworks', helper.directory, 'Contents', 'Info.plist')
}))

function registerWithLaunchServices() {
  execFileSync(launchServicesRegister, ['-f', appBundle], { stdio: 'ignore' })
}

function signingIdentity() {
  try {
    const identities = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
    const developerId = /^\s*\d+\)\s+([A-F0-9]{40})\s+"Developer ID Application:/m.exec(identities)
    const appleDevelopment = /^\s*\d+\)\s+([A-F0-9]{40})\s+"Apple Development:/m.exec(identities)
    return developerId?.[1] ?? appleDevelopment?.[1] ?? '-'
  } catch {
    return '-'
  }
}

function plistValue(key, plist = infoPlist) {
  return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()
}

function setPlistString(key, value, plist = infoPlist) {
  let operation = '-replace'
  try {
    plistValue(key, plist)
  } catch {
    operation = '-insert'
  }
  execFileSync('/usr/bin/plutil', [operation, key, '-string', value, plist], { stdio: 'inherit' })
}

function hasPreparedBundleMetadata() {
  try {
    if (
      plistValue('CFBundleIdentifier') !== developmentBundleId
      || plistValue('CFBundleDisplayName') !== developmentAppName
      || plistValue('CFBundleName') !== developmentAppName
      || plistValue('NSMicrophoneUsageDescription') !== microphoneUsageDescription
      || plistValue('NSSpeechRecognitionUsageDescription') !== speechRecognitionUsageDescription
      || plistValue('NSDownloadsFolderUsageDescription') !== downloadsUsageDescription
      || plistValue('NSDesktopFolderUsageDescription') !== desktopUsageDescription
      || plistValue('NSDocumentsFolderUsageDescription') !== documentsUsageDescription
    ) return false
    return helperBundles.every((helper) => (
      plistValue('CFBundleIdentifier', helper.infoPlist) === helper.bundleId
      && plistValue('NSMicrophoneUsageDescription', helper.infoPlist) === microphoneUsageDescription
      && plistValue('NSSpeechRecognitionUsageDescription', helper.infoPlist) === speechRecognitionUsageDescription
    ))
  } catch {
    return false
  }
}

let signatureValid = true
let signatureHasTeam = false
try {
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appBundle], { stdio: 'ignore' })
  const teamId = (path) => {
    const inspected = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', path], { encoding: 'utf8' })
    return /^TeamIdentifier=(.+)$/m.exec(inspected.stderr ?? '')?.[1]
  }
  const mainTeam = teamId(appBundle)
  const executables = execFileSync('/usr/bin/find', [
    join(appBundle, 'Contents'), '-type', 'f', '-perm', '-111'
  ], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  signatureHasTeam = Boolean(
    mainTeam
    && mainTeam !== 'not set'
    && executables.every((path) => teamId(path) === mainTeam)
  )
} catch {
  signatureValid = false
}

const identity = signingIdentity()
if (
  hasPreparedBundleMetadata()
  && signatureValid
  && (identity === '-' || signatureHasTeam)
) {
  registerWithLaunchServices()
  process.exit(0)
}

setPlistString('CFBundleIdentifier', developmentBundleId)
setPlistString('CFBundleDisplayName', developmentAppName)
setPlistString('CFBundleName', developmentAppName)
setPlistString('NSMicrophoneUsageDescription', microphoneUsageDescription)
setPlistString('NSSpeechRecognitionUsageDescription', speechRecognitionUsageDescription)
setPlistString('NSDownloadsFolderUsageDescription', downloadsUsageDescription)
setPlistString('NSDesktopFolderUsageDescription', desktopUsageDescription)
setPlistString('NSDocumentsFolderUsageDescription', documentsUsageDescription)
for (const helper of helperBundles) {
  setPlistString('CFBundleIdentifier', helper.bundleId, helper.infoPlist)
  setPlistString('CFBundleName', helper.name, helper.infoPlist)
  setPlistString('NSMicrophoneUsageDescription', microphoneUsageDescription, helper.infoPlist)
  setPlistString('NSSpeechRecognitionUsageDescription', speechRecognitionUsageDescription, helper.infoPlist)
}

// The Electron signer walks dylibs, frameworks, helpers and the outer app in
// dependency order. A raw `codesign --deep` leaves nested libraries on their
// previous team and dyld rejects the mixed-team process at launch.
if (identity === '-') {
  execFileSync('/usr/bin/codesign', [
    '--force', '--deep', '--sign', '-', '--entitlements', entitlements, appBundle
  ], { stdio: 'inherit' })
} else {
  await signApp({
    app: appBundle,
    identity,
    platform: 'darwin',
    // osx-sign applies timestamp overrides per file. Disabling the network
    // timestamp service keeps a local development re-sign deterministic and
    // avoids one network round-trip for every Electron resource.
    optionsForFile: () => ({ timestamp: 'none' }),
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false
  })
}
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appBundle], { stdio: 'inherit' })
registerWithLaunchServices()

console.log(`Prepared ${developmentAppName} host (${developmentBundleId}, ${identity === '-' ? 'ad-hoc' : 'developer signed'})`)
