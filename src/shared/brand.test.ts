import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { displayName, PRODUCT_NAME, PRODUCT_NAME_DEV, PRODUCT_TAGLINE } from './brand'

const root = join(__dirname, '..', '..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

/** Tracked text files, as the repository sees them. */
function textFiles(): string[] {
  return execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
    .filter(file => !/^(node_modules|out)\//.test(file) && !/package-lock\.json$|\.(png|jpg|icns|ico|svg|gif|webp|zip|tgz)$/.test(file) && !file.startsWith('docs/validation/'))
    .filter(file => existsSync(join(root, file)))
}

describe('the product is Foundry', () => {
  it('has one display name, for release and development builds', () => {
    expect(PRODUCT_NAME).toBe('Foundry')
    expect(displayName(false)).toBe('Foundry')
    expect(displayName(true)).toBe('Foundry Dev')
    expect(PRODUCT_NAME_DEV).toBe('Foundry Dev')
    expect(PRODUCT_TAGLINE).toBe('The developer workbench where agents build software.')
  })

  it('is what the window, installers and update artifacts are called', () => {
    expect(read('src/renderer/index.html')).toContain('<title>Foundry</title>')
    const build = JSON.parse(read('package.json')).build
    expect(build.productName).toBe('Foundry')
    expect(build.dmg.title).toContain('Foundry')
    expect(JSON.stringify(build.mac.extendInfo)).not.toMatch(/Douchat/)
    expect(read('.github/workflows/release.yml')).toContain('Foundry-$version-mac-$arch.dmg')
    expect(read('README.md')).toContain('<h1 align="center">Foundry</h1>')
  })

  it('is spelled out in the macOS menu and About panel, over the compatibility application name', () => {
    const main = read('src/main/index.ts')
    expect(main).toContain('setAboutPanelOptions({ applicationName: name')
    expect(main).toContain('label: `About ${name}`')
    expect(main).toContain("app.setName(applicationName(development))") // compatibility: the Keychain service
    expect(read('src/main/userData.ts')).toContain('Safe Storage'.length ? 'Compatibility identity' : '')
  })
})

describe('the logo', () => {
  it('is the supplied artwork on a transparent canvas, in every format the build uses', () => {
    for (const file of ['foundry.png', 'foundry-dev.png', 'foundry.icns', 'foundry-dev.icns', 'foundry.ico', 'foundry-source.jpg']) expect(existsSync(join(root, 'resources/icons', file)), file).toBe(true)
    for (const gone of ['douchat.png', 'douchat.icns', 'douchat.ico', 'douchat.svg', 'douchat-dev.png']) expect(existsSync(join(root, 'resources/icons', gone)), gone).toBe(false)
    const png = readFileSync(join(root, 'resources/icons/foundry.png'))
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect(png.readUInt32BE(16)).toBe(1024); expect(png.readUInt32BE(20)).toBe(1024)
    expect(png[25]).toBe(6) // colour type 6: RGBA, so the corners can be transparent
    const ico = readFileSync(join(root, 'resources/icons/foundry.ico'))
    expect(ico.readUInt16LE(2)).toBe(1); expect(ico.readUInt16LE(4)).toBeGreaterThan(1)
    expect(readFileSync(join(root, 'resources/icons/foundry.icns')).subarray(0, 4).toString()).toBe('icns')
  })

  it('is loaded through the existing asset pipeline: the window/Dock icon, the electron-builder icons and the in-app marks', () => {
    const build = JSON.parse(read('package.json')).build
    expect(build.mac.icon).toBe('resources/icons/foundry.icns')
    expect(build.win.icon).toBe('resources/icons/foundry.ico')
    expect(build.linux.icon).toBe('resources/icons/foundry.png')
    expect(read('src/main/index.ts')).toContain("development ? 'foundry-dev.png' : 'foundry.png'")
    expect(read('src/renderer/src/components/SettingsPanel.tsx')).toContain("resources/icons/foundry.png")
    expect(read('src/renderer/src/components/ChatPane.tsx')).toContain("resources/icons/foundry.png")
    expect(read('src/renderer/src/components/SettingsPanel.tsx')).toContain('<h1>Foundry</h1>')
  })
})

describe('the old name', () => {
  const documented = ((): { klass: string; pattern: RegExp; source: string }[] => {
    const doc = read('docs/foundry-identifiers.md')
    return [...doc.matchAll(/^\| (compatibility|retained|historical) \| `([^`]+)` \|/gm)].map(([, klass, source]) => ({ klass, source, pattern: new RegExp(source.replace(/\\\|/g, '|')) }))
  })()
  const tokens = ((): Map<string, string[]> => {
    const found = new Map<string, string[]>()
    for (const file of textFiles().filter(name => !['docs/foundry-identifiers.md', 'src/shared/brand.test.ts'].includes(name))) {
      const text = readFileSync(join(root, file), 'utf8')
      for (const [match] of text.matchAll(/[A-Za-z0-9_.:/@-]*douchat[A-Za-z0-9_.:/@-]*/gi)) {
        const token = match.replace(/^[.:/@-]+|[.:/@-]+$/g, '')
        found.set(token, [...(found.get(token) ?? []), file])
      }
    }
    return found
  })()

  it('no longer appears as a product name anywhere a person reads (only the documented compatibility spots)', () => {
    const allowed = new Set(['docs/foundry.md', 'docs/foundry-identifiers.md', 'src/main/userData.ts', 'src/main/userData.test.ts', 'src/main/index.ts', 'src/shared/groupText.ts'])
    const offenders = textFiles().filter(file => !allowed.has(file) && file !== 'src/shared/brand.test.ts')
      .flatMap(file => [...readFileSync(join(root, file), 'utf8').matchAll(/(^|[^A-Za-z0-9_])Douchat(?![A-Za-z0-9_])/g)].map(() => file))
    expect([...new Set(offenders)]).toEqual([])
  })

  it('is documented: every remaining identifier matches a row of docs/foundry-identifiers.md', () => {
    expect(documented.length).toBeGreaterThan(10)
    const undocumented = [...tokens.keys()].filter(token => !documented.some(({ pattern }) => pattern.test(token)))
    expect(undocumented.map(token => `${token}  (${[...new Set(tokens.get(token))].slice(0, 2).join(', ')})`)).toEqual([])
  })

  it('has no stale rows: every documented pattern still matches something', () => {
    const stale = documented.filter(({ pattern }) => ![...tokens.keys()].some(token => pattern.test(token))).map(({ source }) => source)
    expect(stale).toEqual([])
  })
})
