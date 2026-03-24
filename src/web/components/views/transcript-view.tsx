import type { ComponentProps, ReactElement } from "react"
import { SessionMessages } from "../session-browser.tsx"

type MessagesProps = ComponentProps<typeof SessionMessages>

export function TranscriptView({ messagesProps }: { messagesProps: MessagesProps }): ReactElement {
  return <SessionMessages {...messagesProps} className="bento-full-page" hideTasks />
}
