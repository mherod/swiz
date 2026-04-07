export interface CommandOption {
  flags: string
  description: string
  hidden?: boolean
}

export interface Command<Opts = never> {
  name: string
  description: string
  usage?: string
  options?: CommandOption[]
  run(args: string[], opts?: Opts): Promise<void> | void
}
