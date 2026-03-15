import type { ComponentProps } from "react"
import { SessionMessages } from "../session-browser.tsx"

type MessagesProps = ComponentProps<typeof SessionMessages>

export function TranscriptView({ messagesProps }: { messagesProps: MessagesProps }) {
  return (
    <div className="bento-full-page">
      <SessionMessages {...messagesProps} hideTasks />
    </div>
  )
}
