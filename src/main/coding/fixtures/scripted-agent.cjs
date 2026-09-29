#!/usr/bin/env node
'use strict'
/*
 * A deterministic stand-in for a coding-agent CLI, used by the coding tests.
 *
 * Douchat starts it exactly as it starts any custom local agent: a real process,
 * with the prompt as its argument and the project as its working directory. What
 * it does then is real too — it reads the repository, runs real commands in it
 * and rewrites a real file — but the decisions are scripted, not a model's.
 *
 * The task is the last `CODING-TASK {json}` line of the prompt.
 */
const { execFileSync, spawn } = require('node:child_process')
const { readFileSync, writeFileSync, readdirSync, appendFileSync } = require('node:fs')
const { realpathSync } = require('node:fs')

const prompt = process.argv[process.argv.length - 1]
const marker = prompt.lastIndexOf('CODING-TASK ')
const task = (() => {
  // A continued conversation replays earlier turns in the prompt; a turn with no task of its own just looks around.
  if (marker < 0) return { action: 'none' }
  try { return JSON.parse(prompt.slice(marker + 'CODING-TASK '.length).split('\n')[0]) } catch { return { action: 'none' } }
})()
const cwd = realpathSync(process.cwd())
const lines = [`cwd=${cwd}`]
const run = (file, args) => {
  try { return { code: 0, out: execFileSync(file, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } }
  catch (error) { return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` } }
}
if (task.log) appendFileSync(task.log, `start ${task.name} ${Date.now()}\n`)

if (task.action === 'fix-add') {
  lines.push(`files=${readdirSync(cwd).filter(name => name !== '.git').sort().join(',')}`)
  lines.push(`git-before=${run('git', ['status', '--porcelain']).out.trim() || 'clean'}`)
  lines.push(`test-before=${run('npm', ['test']).code}`)
  const path = `${cwd}/${task.file ?? 'src/math.js'}`
  const source = readFileSync(path, 'utf8')
  writeFileSync(path, source.replace('return a - b', 'return a + b'))
  const after = run('npm', ['test'])
  lines.push(`test-after=${after.code}`)
  lines.push(`git-after=${run('git', ['status', '--porcelain']).out.trim()}`)
  console.log(lines.join('\n'))
  if (task.log) appendFileSync(task.log, `end ${task.name} ${Date.now()}\n`)
} else if (task.action === 'hang') {
  // A child that would outlive its parent if nothing cleaned up the process group.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  writeFileSync(task.pidfile, `${process.pid}\n${child.pid}\n`)
  setInterval(() => {}, 1000)
} else if (task.action === 'fail') {
  console.error('the scripted agent could not complete the task')
  process.exit(2)
} else {
  console.log(lines.join('\n'))
}
