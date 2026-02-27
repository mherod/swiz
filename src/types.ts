export interface CommandOption {
  flags: string
  description: string
}

export interface Command {
  name: string
  description: string
  usage?: string
  options?: CommandOption[]
  run(args: string[]): Promise<void> | void
}
