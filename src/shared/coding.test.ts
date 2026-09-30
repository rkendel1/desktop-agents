import { describe, expect, it } from 'vitest'
import { canContinue, changeLabel, codingDisplayState, describeApproval, formatCommandLine, isDeferredWorkReply, isUntracked, parseCommandLine } from './coding'

describe('coding display', () => {
  it('shows waiting for approval only for a running session that is waiting; every other state is the backend’s', () => {
    expect(codingDisplayState({ status: 'running' })).toBe('running')
    expect(codingDisplayState({ status: 'running' }, { state: 'awaiting-approval' })).toBe('awaiting-approval')
    expect(codingDisplayState({ status: 'running' }, { state: 'running' })).toBe('running')
    for (const status of ['succeeded', 'failed', 'cancelled', 'interrupted'] as const) expect(codingDisplayState({ status }, { state: 'awaiting-approval' })).toBe(status)
    expect(codingDisplayState({ status: 'succeeded', result: "I'm checking this and I'll share a plan shortly.", changes: [] })).toBe('failed')
    expect(codingDisplayState({ status: 'succeeded', result: "I'll share more later.", changes: [{ path: 'a.ts', code: ' M', origin: 'session' }] })).toBe('succeeded')
  })

  it('lets any finished session continue, and never a running one', () => {
    expect(canContinue({ status: 'running' })).toBe(false)
    for (const status of ['succeeded', 'failed', 'cancelled', 'interrupted'] as const) expect(canContinue({ status })).toBe(true)
  })

  it('distinguishes deferred progress claims from completed findings', () => {
    expect(isDeferredWorkReply("I'm reviewing the setup and I'll have more details shortly.")).toBe(true)
    expect(isDeferredWorkReply("I'll propose a plan once I've reviewed the configuration.")).toBe(true)
    expect(isDeferredWorkReply('I reviewed the setup. The shared route is configured in src/router.ts.')).toBe(false)
    expect(isDeferredWorkReply('No change was needed because the existing test already covers this case.')).toBe(false)
  })

  it('describes what an agent wants to do, relative to the project', () => {
    const request = (tool: string, input: object) => ({ operation: `Claude: ${tool}`, details: JSON.stringify({ tool, input }) })
    expect(describeApproval(request('Bash', { command: 'npm test | head' }))).toEqual({ verb: 'Run', target: 'npm test | head' })
    expect(describeApproval(request('Edit', { file_path: '/work/app/src/math.js' }), '/work/app')).toEqual({ verb: 'Edit', target: 'src/math.js' })
    expect(describeApproval(request('Write', { file_path: '/elsewhere/x.js' }), '/work/app')).toEqual({ verb: 'Write', target: '/elsewhere/x.js' })
    expect(describeApproval(request('Read', { file_path: '/work/app/package.json' }), '/work/app/')).toEqual({ verb: 'Read', target: 'package.json' })
    expect(describeApproval({ operation: 'Allow Computer Use?', details: 'not json' })).toEqual({ verb: 'Do', target: 'Allow Computer Use?' })
  })

  it('splits command lines into arguments without a shell', () => {
    expect(parseCommandLine('npm test')).toEqual(['npm', 'test'])
    expect(parseCommandLine('  node  -e "console.log(1 + 2)" \'a b\'  ')).toEqual(['node', '-e', 'console.log(1 + 2)', 'a b'])
    expect(parseCommandLine('echo "" x')).toEqual(['echo', '', 'x'])
    expect(parseCommandLine('   ')).toEqual([])
    expect(parseCommandLine('rm -rf $HOME; echo')).toEqual(['rm', '-rf', '$HOME;', 'echo'])
    expect(() => parseCommandLine('echo "unclosed')).toThrow(/quote/i)
    expect(parseCommandLine(formatCommandLine(['node', '-e', 'a b', '']))).toEqual(['node', '-e', 'a b', ''])
  })

  it('labels git status codes', () => {
    expect(changeLabel({ code: ' M' })).toBe('Modified')
    expect(changeLabel({ code: '??' })).toBe('Untracked')
    expect(changeLabel({ code: 'A ' })).toBe('Added')
    expect(changeLabel({ code: ' D' })).toBe('Deleted')
    expect(changeLabel({ code: 'R ' })).toBe('Renamed')
    expect(isUntracked({ code: '??' })).toBe(true)
    expect(isUntracked({ code: ' M' })).toBe(false)
  })
})
