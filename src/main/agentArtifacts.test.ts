import { expect, it, vi } from 'vitest'
import { createArtifactTools } from './agentArtifacts'
import type { AgentSkill } from '../shared/agentCustomization'
vi.mock('./shellPath', () => ({ spawnEnvironment: async () => ({ PATH: process.env.PATH }) }))
const script = "require('node:fs').writeFileSync('deck.html', '<html>Slides</html>'); console.log('done')"
const skill: AgentSkill = { id: 'slides', name: 'slides', enabled: true, content: 'Slides', files: [{ path: 'scripts/build.cjs', data: Buffer.from(script).toString('base64') }] }
function host() {
  const save = vi.fn(async (name: string, _bytes: Uint8Array) => `[${name}](<douchat-file:///test/${name}>)`)
  const authorize = vi.fn(async () => {})
  const tools = createArtifactTools({ skills: () => [skill], save, authorize })
  return { save, authorize, call: (name: string, args: object, signal?: AbortSignal) => tools.find(t => t.name === name)!.execute('test', args, signal) }
}
it('creates a complete HTML deliverable without executing scripts or requesting shell access', async () => {
  const h = host()
  const result = await h.call('create_file', { name: 'deck.html', content: '<html><h1>Foundry</h1></html>' })
  expect(h.save).toHaveBeenCalledWith('deck.html', Buffer.from('<html><h1>Foundry</h1></html>'), undefined)
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining('douchat-file:') })
  expect(h.authorize).not.toHaveBeenCalled()
  await expect(h.call('create_file', { name: '../outside.html', content: 'x' })).rejects.toThrow()
})
it('executes an approved packaged script and delivers its output', async () => {
  const h = host()
  const result = await h.call('run_skill_script', { skillId: 'slides', path: 'scripts/build.cjs', outputs: ['deck.html'] })
  expect(h.authorize).toHaveBeenCalledOnce()
  expect(h.save.mock.calls[0][0]).toBe('deck.html')
  expect(Buffer.from(h.save.mock.calls[0][1]).toString()).toBe('<html>Slides</html>')
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining('done') })
})
it('never runs or saves outputs when owner denies or cancels', async () => {
  const h = host()
  h.authorize.mockRejectedValueOnce(new Error('Denied'))
  await expect(h.call('run_skill_script', { skillId: 'slides', path: 'scripts/build.cjs', outputs: ['deck.html'] })).rejects.toThrow('Denied')
  const stop = new AbortController()
  h.authorize.mockImplementationOnce(async () => { stop.abort() })
  await expect(h.call('run_skill_script', { skillId: 'slides', path: 'scripts/build.cjs', outputs: ['deck.html'] }, stop.signal)).rejects.toThrow()
  expect(h.save).not.toHaveBeenCalled()
})
it('rejects scripts outside the enabled package', async () => {
  const h = host()
  await expect(h.call('run_skill_script', { skillId: 'slides', path: '../evil.py', outputs: [] })).rejects.toThrow()
  await expect(h.call('run_skill_script', { skillId: 'other', path: 'main.py', outputs: [] })).rejects.toThrow('Enabled skill')
  expect(h.authorize).not.toHaveBeenCalled()
})
it('stops a running script and does not deliver partial outputs', async () => {
  const slow = { ...skill, files: [{ path: 'wait.cjs', data: Buffer.from("setInterval(() => {}, 1000)").toString('base64') }] }
  const save = vi.fn(async () => 'unused')
  const tools = createArtifactTools({ skills: () => [slow], authorize: async () => {}, save })
  const stop = new AbortController()
  const task = tools[1].execute('test', { skillId: 'slides', path: 'wait.cjs', outputs: ['out.txt'] }, stop.signal)
  setTimeout(() => stop.abort(), 100)
  await expect(task).rejects.toThrow(/cancelled|aborted/i)
  expect(save).not.toHaveBeenCalled()
})
