// Human-readable lines on stderr plus an append-only JSONL event log for every run.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export class Log {
  private file: string | undefined

  constructor(file?: string) {
    this.file = file
    if (file) mkdirSync(dirname(file), { recursive: true })
  }

  info(message: string): void {
    process.stderr.write(`${new Date().toISOString().slice(11, 23)} ${message}\n`)
  }

  /** Records a structured event; bigint values are written as strings. */
  event(type: string, fields: Record<string, unknown> = {}): void {
    if (!this.file) return
    const line = JSON.stringify({ t: new Date().toISOString(), type, ...fields }, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
    appendFileSync(this.file, line + '\n')
  }
}

export const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z'
