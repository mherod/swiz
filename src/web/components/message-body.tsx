import type { ReactNode } from "react"
import { cn } from "../lib/cn.ts"
import {
  formatAssistantJsonBlocks,
  normalizeAssistantText,
  splitAssistantMessage,
  splitUserMessage,
} from "../lib/message-format.ts"
import { Markdown } from "./markdown.tsx"
import {
  buildCollapseHint,
  COLLAPSE_CHAR_THRESHOLD,
  COLLAPSE_LINE_THRESHOLD,
  compactPath,
  looksLikeLogBlob,
  summarizeText,
} from "./session-browser-utils.ts"

type ParsedBlock = NonNullable<ReturnType<typeof splitUserMessage>["metadataBlocks"]>[number]

const BLOCK_KIND_CLASS: Record<string, string> = {
  gitAction: "hook-context-priority",
  elementContext: "hook-context-technical",
  localCommandCaveat: "hook-context-caveat",
  localCommand: "hook-context-local-command",
  bashCommand: "hook-context-bash",
}

function blockKindClassName(kind: string | undefined): string | null {
  if (!kind) return null
  return BLOCK_KIND_CLASS[kind] ?? null
}

function BlockTitle({ block }: { block: ParsedBlock }) {
  if (block.kind === "localCommandCaveat") {
    return (
      <div className="local-command-caveat-header">
        <span className="caveat-icon">ⓘ</span>
        <p className="hook-context-title">{block.title}</p>
      </div>
    )
  }
  if (block.kind === "localCommand") {
    return (
      <div className="local-command-header">
        <span className="terminal-icon">›_</span>
        <p className="hook-context-title">{block.title}</p>
      </div>
    )
  }
  if (block.kind === "bashCommand") {
    return (
      <div className="local-command-header">
        <span className="terminal-icon">❯</span>
        <p className="hook-context-title">{block.title}</p>
      </div>
    )
  }
  return <p className="hook-context-title">{block.title}</p>
}

function BlockDetails({ block }: { block: ParsedBlock }) {
  if (block.details.length === 0) return null
  return (
    <ul className="hook-context-list">
      {block.details.map((item) => (
        <li key={`${item.label}:${item.value}`} className="hook-context-item">
          <span className="hook-context-label">{item.label}</span>
          <code
            className={cn(
              "hook-context-value",
              block.kind === "localCommand" && item.label === "output" && "command-output"
            )}
          >
            {item.value}
          </code>
        </li>
      ))}
    </ul>
  )
}

function BlockNotes({ block }: { block: ParsedBlock }) {
  return (
    <>
      {block.notes.map((note) => (
        <p key={`${block.title}:${note}`} className="hook-context-note">
          {note}
        </p>
      ))}
    </>
  )
}

function MetadataBlockItem({ block, unwrap }: { block: ParsedBlock; unwrap: boolean }) {
  if (unwrap) {
    return (
      <div className={cn("hook-context-box", blockKindClassName(block.kind))}>
        <BlockTitle block={block} />
        <BlockDetails block={block} />
        <BlockNotes block={block} />
      </div>
    )
  }
  return (
    <details
      className={cn("hook-context-box hook-context-collapsible", blockKindClassName(block.kind))}
    >
      <summary className="hook-context-summary">
        {block.kind === "localCommandCaveat" && <span className="caveat-icon">ⓘ </span>}
        {block.kind === "localCommand" && <span className="terminal-icon">›_ </span>}
        {block.title}
      </summary>
      <BlockDetails block={block} />
      <BlockNotes block={block} />
    </details>
  )
}

function ObjectiveBlock({
  objective,
}: {
  objective: NonNullable<ReturnType<typeof splitUserMessage>["parsedObjective"]>
}) {
  return (
    <div className="hook-context-box">
      <p className="hook-context-title">{objective.title}</p>
      <ul className="hook-context-list">
        {objective.bullets.map((bullet) => (
          <li key={bullet} className="hook-context-item">
            <span className="hook-context-label">goal</span>
            <span className="hook-context-note">{bullet}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function HookContextBlock({
  hookContext,
}: {
  hookContext: NonNullable<ReturnType<typeof splitUserMessage>["hookContext"]>
}) {
  return (
    <div className="hook-context-box">
      <p className="hook-context-title">
        Hook context{hookContext.source ? ` (${hookContext.source})` : ""}
      </p>
      {hookContext.details.length > 0 ? (
        <ul className="hook-context-list">
          {hookContext.details.map((item) => (
            <li key={`${item.label}:${item.value}`} className="hook-context-item">
              <span className="hook-context-label">{item.label}</span>
              <code className="hook-context-value">{item.value}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {hookContext.notes.map((note) => (
        <p key={note} className="hook-context-note">
          {note}
        </p>
      ))}
    </div>
  )
}

function AttachedSkillsBlock({
  skills,
}: {
  skills: NonNullable<ReturnType<typeof splitUserMessage>["attachedSkills"]>
}) {
  return (
    <details className="hook-context-box hook-context-collapsible">
      <summary className="hook-context-summary">{skills.title}</summary>
      {skills.skills.length > 0 ? (
        <ul className="hook-context-list">
          {skills.skills.map((skill) => (
            <li key={`${skill.name}:${skill.path ?? ""}`} className="hook-context-item">
              <span className="hook-context-label">{skill.name}</span>
              {skill.path ? (
                <code className="hook-context-value" title={skill.path}>
                  {compactPath(skill.path)}
                </code>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {skills.notes.map((note) => (
        <p key={note} className="hook-context-note">
          {note}
        </p>
      ))}
    </details>
  )
}

interface UserContextBlocksProps {
  parsedObjective: ReturnType<typeof splitUserMessage>["parsedObjective"] | undefined
  hookContext: ReturnType<typeof splitUserMessage>["hookContext"] | undefined
  attachedSkills: ReturnType<typeof splitUserMessage>["attachedSkills"] | undefined
  metadataBlocks: ReturnType<typeof splitUserMessage>["metadataBlocks"] | undefined
}

function isSingleGitAction(props: UserContextBlocksProps): boolean {
  return (
    !props.parsedObjective &&
    !props.hookContext &&
    !props.attachedSkills &&
    (props.metadataBlocks ?? []).length === 1 &&
    (props.metadataBlocks ?? [])[0]?.kind === "gitAction"
  )
}

function renderUserContextBlocks(
  parsedObjective: UserContextBlocksProps["parsedObjective"],
  hookContext: UserContextBlocksProps["hookContext"],
  attachedSkills: UserContextBlocksProps["attachedSkills"],
  metadataBlocks: UserContextBlocksProps["metadataBlocks"]
): ReactNode {
  const blocks = metadataBlocks ?? []
  const hasContext =
    Boolean(parsedObjective) || Boolean(hookContext) || Boolean(attachedSkills) || blocks.length > 0
  const shouldUnwrap = isSingleGitAction({
    parsedObjective,
    hookContext,
    attachedSkills,
    metadataBlocks,
  })
  return (
    <>
      {parsedObjective ? <ObjectiveBlock objective={parsedObjective} /> : null}
      {hookContext ? <HookContextBlock hookContext={hookContext} /> : null}
      {attachedSkills ? <AttachedSkillsBlock skills={attachedSkills} /> : null}
      {blocks.map((block, idx) => (
        <MetadataBlockItem key={`${block.title}-${idx}`} block={block} unwrap={shouldUnwrap} />
      ))}
      {hasContext ? <span className="sr-only">Parsed message context available.</span> : null}
    </>
  )
}

function ThoughtBlock({ thoughtText }: { thoughtText: string | null | undefined }) {
  if (!thoughtText) return null
  return (
    <details className="assistant-thought">
      <summary>Model reasoning</summary>
      <pre className="message-log assistant-thought-body">{thoughtText}</pre>
    </details>
  )
}

function MessageContent({ text, asLog }: { text: string; asLog: boolean }) {
  if (!text) return null
  return asLog ? <pre className="message-log">{text}</pre> : <Markdown text={text} />
}

type AssistantParts = ReturnType<typeof splitAssistantMessage> | null

function AssistantBody({ text, parts }: { text: string; parts: AssistantParts }) {
  const visibleText = parts?.visibleText ?? text
  const withJson = formatAssistantJsonBlocks(visibleText)
  const preparedText = normalizeAssistantText(withJson)
  const lines = preparedText.split("\n")
  const shouldCollapse =
    lines.length > COLLAPSE_LINE_THRESHOLD || preparedText.length > COLLAPSE_CHAR_THRESHOLD
  const hasCodeFence = preparedText.includes("```")
  const asLog = !hasCodeFence && looksLikeLogBlob(preparedText)
  const thoughtText = parts?.thoughtText

  if (!shouldCollapse || hasCodeFence) {
    return (
      <>
        <MessageContent text={preparedText} asLog={asLog} />
        <ThoughtBlock thoughtText={thoughtText} />
      </>
    )
  }

  const preview = summarizeText(preparedText)
  const hint = buildCollapseHint(preparedText)
  return (
    <>
      {preparedText ? (
        <details className="message-collapsible">
          <summary>
            <MessageContent text={preview} asLog={asLog} />
            <span className="message-expand-hint">{hint}</span>
          </summary>
          <MessageContent text={preparedText} asLog={asLog} />
        </details>
      ) : null}
      <ThoughtBlock thoughtText={thoughtText} />
    </>
  )
}

function UserBody({
  text,
  parts,
}: {
  text: string
  parts: ReturnType<typeof splitUserMessage> | null
}) {
  const userVisible = parts?.visibleText ?? text
  const lines = userVisible.split("\n")
  const shouldCollapse =
    lines.length > COLLAPSE_LINE_THRESHOLD || userVisible.length > COLLAPSE_CHAR_THRESHOLD
  const hasOnlyContext = userVisible.trim().length === 0
  const contextBlocks = renderUserContextBlocks(
    parts?.parsedObjective,
    parts?.hookContext,
    parts?.attachedSkills,
    parts?.metadataBlocks ?? []
  )

  if (!shouldCollapse) {
    return (
      <>
        {!hasOnlyContext ? <pre className="message-text">{userVisible}</pre> : null}
        {contextBlocks}
      </>
    )
  }

  const preview = summarizeText(userVisible)
  const hint = buildCollapseHint(userVisible)
  return (
    <>
      <details className="message-collapsible">
        <summary>
          <pre className="message-text">{preview}</pre>
          <span className="message-expand-hint">{hint}</span>
        </summary>
        <pre className="message-text">{userVisible}</pre>
      </details>
      {contextBlocks}
    </>
  )
}

export function MessageBody({ text, role }: { text: string; role: "user" | "assistant" }) {
  if (role === "assistant") {
    return <AssistantBody text={text} parts={splitAssistantMessage(text)} />
  }
  return <UserBody text={text} parts={splitUserMessage(text)} />
}
