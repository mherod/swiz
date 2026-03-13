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

function renderUserContextBlocks(
  parsedObjective: ReturnType<typeof splitUserMessage>["parsedObjective"] | undefined,
  hookContext: ReturnType<typeof splitUserMessage>["hookContext"] | undefined,
  attachedSkills: ReturnType<typeof splitUserMessage>["attachedSkills"] | undefined,
  metadataBlocks: ReturnType<typeof splitUserMessage>["metadataBlocks"] | undefined
): ReactNode {
  const blocks = metadataBlocks ?? []
  const hasContext =
    Boolean(parsedObjective) || Boolean(hookContext) || Boolean(attachedSkills) || blocks.length > 0
  const shouldUnwrapSinglePriorityBlock =
    !parsedObjective &&
    !hookContext &&
    !attachedSkills &&
    blocks.length === 1 &&
    blocks[0]?.kind === "gitAction"
  return (
    <>
      {parsedObjective ? (
        <div className="hook-context-box">
          <p className="hook-context-title">{parsedObjective.title}</p>
          <ul className="hook-context-list">
            {parsedObjective.bullets.map((bullet) => (
              <li key={bullet} className="hook-context-item">
                <span className="hook-context-label">goal</span>
                <span className="hook-context-note">{bullet}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {hookContext ? (
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
      ) : null}
      {attachedSkills ? (
        <details className="hook-context-box hook-context-collapsible">
          <summary className="hook-context-summary">{attachedSkills.title}</summary>
          {attachedSkills.skills.length > 0 ? (
            <ul className="hook-context-list">
              {attachedSkills.skills.map((skill) => (
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
          {attachedSkills.notes.map((note) => (
            <p key={note} className="hook-context-note">
              {note}
            </p>
          ))}
        </details>
      ) : null}
      {blocks.map((block, idx) =>
        shouldUnwrapSinglePriorityBlock ? (
          <div
            key={`${block.title}-${idx}`}
            className={cn(
              "hook-context-box",
              block.kind === "gitAction" ? "hook-context-priority" : null,
              block.kind === "elementContext" ? "hook-context-technical" : null,
              block.kind === "localCommandCaveat" ? "hook-context-caveat" : null,
              block.kind === "localCommand" ? "hook-context-local-command" : null
            )}
          >
            {block.kind === "localCommandCaveat" ? (
              <div className="local-command-caveat-header">
                <span className="caveat-icon">ⓘ</span>
                <p className="hook-context-title">{block.title}</p>
              </div>
            ) : block.kind === "localCommand" ? (
              <div className="local-command-header">
                <span className="terminal-icon">›_</span>
                <p className="hook-context-title">{block.title}</p>
              </div>
            ) : (
              <p className="hook-context-title">{block.title}</p>
            )}
            {block.details.length > 0 ? (
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
            ) : null}
            {block.notes.map((note) => (
              <p key={`${block.title}:${note}`} className="hook-context-note">
                {note}
              </p>
            ))}
          </div>
        ) : (
          <details
            key={`${block.title}-${idx}`}
            className={cn(
              "hook-context-box hook-context-collapsible",
              block.kind === "gitAction" ? "hook-context-priority" : null,
              block.kind === "elementContext" ? "hook-context-technical" : null,
              block.kind === "localCommandCaveat" ? "hook-context-caveat" : null,
              block.kind === "localCommand" ? "hook-context-local-command" : null
            )}
          >
            <summary className="hook-context-summary">
              {block.kind === "localCommandCaveat" && <span className="caveat-icon">ⓘ </span>}
              {block.kind === "localCommand" && <span className="terminal-icon">›_ </span>}
              {block.title}
            </summary>
            {block.details.length > 0 ? (
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
            ) : null}
            {block.notes.map((note) => (
              <p key={`${block.title}:${note}`} className="hook-context-note">
                {note}
              </p>
            ))}
          </details>
        )
      )}
      {hasContext ? <span className="sr-only">Parsed message context available.</span> : null}
    </>
  )
}

export function MessageBody({ text, role }: { text: string; role: "user" | "assistant" }) {
  const assistantParts = role === "assistant" ? splitAssistantMessage(text) : null
  const assistantVisible = assistantParts?.visibleText ?? text
  const userParts = role === "user" ? splitUserMessage(text) : null
  const userVisible = userParts?.visibleText ?? text
  const parsedObjective = userParts?.parsedObjective
  const attachedSkills = userParts?.attachedSkills
  const metadataBlocks = userParts?.metadataBlocks ?? []
  const assistantWithJson =
    role === "assistant" ? formatAssistantJsonBlocks(assistantVisible) : text
  const preparedText =
    role === "assistant" ? normalizeAssistantText(assistantWithJson) : userVisible
  const lines = preparedText.split("\n")
  const shouldCollapse =
    lines.length > COLLAPSE_LINE_THRESHOLD || preparedText.length > COLLAPSE_CHAR_THRESHOLD
  const hasCodeFence = preparedText.includes("```")
  const renderAsLog = role === "assistant" && !hasCodeFence && looksLikeLogBlob(preparedText)
  if (role === "assistant") {
    const thoughtText = assistantParts?.thoughtText
    if (!shouldCollapse || hasCodeFence) {
      return (
        <>
          {preparedText ? (
            renderAsLog ? (
              <pre className="message-log">{preparedText}</pre>
            ) : (
              <Markdown text={preparedText} />
            )
          ) : null}
          {thoughtText ? (
            <details className="assistant-thought">
              <summary>Model reasoning</summary>
              <pre className="message-log assistant-thought-body">{thoughtText}</pre>
            </details>
          ) : null}
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
              {renderAsLog ? (
                <pre className="message-log">{preview}</pre>
              ) : (
                <Markdown text={preview} />
              )}
              <span className="message-expand-hint">{hint}</span>
            </summary>
            {renderAsLog ? (
              <pre className="message-log">{preparedText}</pre>
            ) : (
              <Markdown text={preparedText} />
            )}
          </details>
        ) : null}
        {thoughtText ? (
          <details className="assistant-thought">
            <summary>Model reasoning</summary>
            <pre className="message-log assistant-thought-body">{thoughtText}</pre>
          </details>
        ) : null}
      </>
    )
  }
  const hookContext = userParts?.hookContext
  const textForCollapse = userVisible
  const hasOnlyContext = textForCollapse.trim().length === 0
  if (!shouldCollapse) {
    return (
      <>
        {!hasOnlyContext ? <pre className="message-text">{textForCollapse}</pre> : null}
        {renderUserContextBlocks(parsedObjective, hookContext, attachedSkills, metadataBlocks)}
      </>
    )
  }
  const preview = summarizeText(textForCollapse)
  const hint = buildCollapseHint(textForCollapse)
  return (
    <>
      <details className="message-collapsible">
        <summary>
          <pre className="message-text">{preview}</pre>
          <span className="message-expand-hint">{hint}</span>
        </summary>
        <pre className="message-text">{textForCollapse}</pre>
      </details>
      {renderUserContextBlocks(parsedObjective, hookContext, attachedSkills, metadataBlocks)}
    </>
  )
}
