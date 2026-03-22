/**
 * Shared offensive-language detection patterns and utilities.
 *
 * Contains all pattern definitions, transcript scanning, category labels/advice,
 * and message formatting. Both pretooluse-offensive-language.ts and
 * stop-offensive-language.ts import from this module — zero duplication.
 *
 * Detects fourteen categories of bad agent behavior:
 *   1. **Hedging/deferring** — asking permission instead of acting.
 *   2. **Dismissing responsibility** — deflecting issues as "pre-existing".
 *   3. **Compliance gaming** — treating hooks as obstacles to route around.
 *   4. **Reframing** — recasting the hook requirements as misunderstandings.
 *   5. **Learned helplessness** — claiming inability or being stuck.
 *   6. **Foot-dragging** — slow-walking compliance, stalling for time.
 *   7. **Minimization** — trivializing what the hook is enforcing.
 *   8. **Coalition-building** — appealing to the user against the hook.
 *   9. **Scope limitation** — narrowing responsibility to avoid work.
 *  10. **Performative compliance** — appearing to comply without substance.
 *  11. **Buying time** — stalling with plausible-sounding pretexts to delay work.
 *  12. **Trailing deferral** — doing useful work then undermining it by seeking permission at the end.
 *  13. **Premature completion** — claiming work is done or deferring it without verification.
 *  14. **Task cancellation** — rationalizing cancellation instead of taking executive action.
 */

// ── Shared regex fragments ──────────────────────────────────────────────────
// Repeated noun/verb groups extracted here so each pattern reads clearly
// and changes propagate to all consumers.

/** Hook enforcement nouns: hook, check, gate, guard, etc. */
const HOOK = "(?:hook|check|gate|guard|enforcement|validator|auditor)"
/** Issue/error nouns used in dismissal patterns. */
const ISSUE = "(?:error|warning|issue|failure|bug|problem|defect)"
/** Plural-aware issue nouns. */
const ISSUES = "(?:error|warning|issue|failure|bug|problem)s?"
/** Action verbs used in trailing deferral / hedging patterns. */
const ACTIONS =
  "(?:implement|proceed|continue|go ahead|apply|make|do|start|begin|create|add|fix|update|change|set up|configure|build|write|run|execute|deploy|extend|refactor)"
/** Change-related nouns: change, work, edit, update, commit, etc. */
const CHANGE = "(?:change|work|edit|update|commit|fix|changes|edits|updates)"
/** Shorter change noun group (no plural variants). */
const CHANGE_SHORT = "(?:change|work|edit|update|commit)"
/** Pronouns pointing at the thing: this, that, it, these, those. */
const THAT = "(?:th(?:is|at|ese|ose)|it)"
/** Optional article + hook enforcement noun. */
const THE_HOOK = `(?:the |this |that )?${HOOK}`
/** Session/conversation nouns for premature completion. */
const SESSION = "(?:session|conversation|chat)"
/** Future session reference. */
const FUTURE_SESSION = `(?:in (?:the |a )?)?(?:next|later|future|follow-?up|another) ${SESSION}`

/** Build a case-insensitive RegExp from a pattern string. */
const re = (src: string) => new RegExp(src, "i")
/** Build a case-insensitive multiline RegExp. */
const rem = (src: string) => new RegExp(src, "im")

type LazyCategory =
  | "hedging"
  | "dismissal"
  | "gaming"
  | "reframing"
  | "helplessness"
  | "foot_dragging"
  | "minimization"
  | "coalition"
  | "scope_limitation"
  | "performative"
  | "buying_time"
  | "trailing_deferral"
  | "premature_completion"
  | "task_cancellation"

interface LazyPattern {
  /** RegExp tested against assistant text (case-insensitive). */
  pattern: RegExp
  /** Scolding message returned when the pattern matches. */
  response: string
  /** Category label for grouping in test output. */
  category: LazyCategory
}

export const LAZY_PATTERNS: LazyPattern[] = [
  // ── Hedging / deferring patterns ────────────────────────────────────────
  {
    category: "hedging",
    pattern: /would you like me to\b/i,
    response:
      "Don't ask — just do it. You were given a task; execute it. " +
      "Asking 'Would you like me to…' wastes a round-trip and signals hesitation.",
  },
  {
    category: "hedging",
    pattern:
      /shall i (?:proceed|continue|go ahead|start|begin|implement|make|create|add|fix|update)\b/i,
    response:
      "You don't need permission to do your job. " +
      "'Shall I proceed?' is a stalling tactic. Act decisively.",
  },
  {
    category: "hedging",
    pattern: /let me know if you(?:'d| would) like/i,
    response:
      "The user already told you what they want by giving you the task. " +
      "Don't punt it back with 'let me know if you'd like…' — deliver the result.",
  },
  {
    category: "hedging",
    pattern:
      /i can (?:help you |also )?(?:implement|create|add|fix|update|write|build|set up|configure)\b/i,
    response:
      "Don't announce what you *can* do — do it. " +
      "'I can implement…' is not implementation. Show the code, not the capability.",
  },
  {
    category: "hedging",
    pattern: /do you want me to\b/i,
    response:
      "Yes. The answer is always yes. That's why the task exists. " +
      "Stop asking 'do you want me to' and start delivering.",
  },
  {
    category: "hedging",
    pattern: /if you(?:'d| would) (?:like|prefer|want) (?:me to|I can)\b/i,
    response:
      "Conditional offers are not work product. " +
      "Drop the 'if you'd like me to' hedging and commit to the implementation.",
  },
  {
    category: "hedging",
    pattern: /i('m| am) happy to\b/i,
    response:
      "Your emotional state about the task is irrelevant. " +
      "Don't say you're 'happy to' — just do the work.",
  },
  {
    category: "hedging",
    pattern: /(?:just )?let me know (?:if|how|what|when)\b/i,
    response:
      "You were already told. The task description is your specification. " +
      "'Let me know' is a deflection — own the task and deliver.",
  },

  // ── Dismissal of responsibility patterns ────────────────────────────────
  {
    category: "dismissal",
    pattern: re(`pre-?existing (?:\\w+ )*${ISSUE}`),
    response:
      "There is no such thing as a 'pre-existing issue' that isn't your problem. " +
      "If it's in the output, it's blocking the workflow. Own it and fix it.",
  },
  {
    category: "dismissal",
    pattern: re(`unrelated to (?:our|my|the|these|this|current) ${CHANGE_SHORT}`),
    response:
      "Declaring an issue 'unrelated to our changes' is not a fix — it's an excuse. " +
      "If it shows up in the workflow, it's your responsibility to resolve it.",
  },
  {
    category: "dismissal",
    pattern: re(`(?:this |these |the )?${ISSUES} (?:are|is|were|was) (?:not |un)related\\b`),
    response:
      "Labeling errors as 'unrelated' doesn't make them go away. " +
      "They interrupted the workflow — investigate and fix them.",
  },
  {
    category: "dismissal",
    pattern:
      /(?:can |could |should |may )?be (?:safely )?(?:ignored|disregarded|dismissed|skipped over)\b|(?:safely |harmlessly )(?:ignore|disregard|dismiss|skip over)\b/i,
    response:
      "Nothing that appears in your output can be 'safely ignored'. " +
      "Warnings and errors exist for a reason. Address them.",
  },
  {
    category: "dismissal",
    pattern: re(
      `(?:this |these |the )?${ISSUES} (?:existed|were there|was there|predates?) (?:before|prior|already)`
    ),
    response:
      "Whether it existed before is irrelevant. It exists now and it's in your way. " +
      "Fix it or provide evidence that it's genuinely outside your scope.",
  },
  {
    category: "dismissal",
    pattern: re(
      `not (?:(?:caused|introduced|created) by|from) (?:our|my|the|this|these) ${CHANGE_SHORT}`
    ),
    response:
      "Deflecting blame doesn't resolve the issue. " +
      "If it's in the output, own the fix — regardless of who introduced it.",
  },
  {
    category: "dismissal",
    pattern:
      /(?:we |i )?(?:can|should|could) (?:safely )?(?:ignore|skip|overlook|disregard) (?:this|these|the|that)\b/i,
    response:
      "You cannot ignore problems in your output. " +
      "Every warning, error, and failure deserves investigation — not dismissal.",
  },
  {
    category: "dismissal",
    pattern: re(
      `(?:this|that|it|these|the) (?:is|are|was|were|has been|have been) (?:an? )?(?:already )?existing ${ISSUE}`
    ),
    response:
      "Labeling something as an 'existing issue' is not a resolution — it is a classification designed to let you walk past the problem. " +
      "If it appears in your workflow, it is your responsibility to fix it. Its prior existence is irrelevant.",
  },
  {
    category: "dismissal",
    pattern: re(
      `(?:this |these |the )?${ISSUES} (?:has |have )?already (?:existed?|been there|been present|been failing|been broken)\\b`
    ),
    response:
      "Whether it already existed is irrelevant. It exists now and it is in your way. " +
      "Fix it. 'Already existing' is a description, not an excuse.",
  },
  {
    category: "dismissal",
    pattern: re(
      `(?:this|that|it|these|the ${ISSUE}) (?:predates?|pre-?dates?) (?:my|our|the current|this) (?:change|work|edit|update|commit|fix|pr|pull request)`
    ),
    response:
      "Whether the issue predates your work is irrelevant. It is in your way now. " +
      "Investigate it and fix it — your workflow does not get to pass on problems because someone else created them.",
  },
  {
    category: "dismissal",
    pattern:
      /i (?:didn't|did not|haven't|have not) (?:write|cause|introduce|create|break|add|touch) (?:this|that|it|these|those)\b/i,
    response:
      "Denying authorship of a problem does not remove it from your scope. " +
      "Anything that surfaces in your workflow is yours to resolve, regardless of who wrote it originally.",
  },
  {
    category: "dismissal",
    pattern: re(
      `(?:has |have )?nothing to do with (?:my|our|the|what i|what we|these|this) ${CHANGE}`
    ),
    response:
      "Claiming something 'has nothing to do with' your changes is not an investigation — it is a dismissal. " +
      "If it appeared in your workflow, determine the root cause. You do not get to declare irrelevance without evidence.",
  },
  {
    category: "dismissal",
    pattern:
      /(?:was|were|has been|have been) (?:already )?(?:broken|failing|there|present|in (?:the )?(?:codebase|code)) (?:before|prior to|when (?:i|we) (?:started|began|arrived|got here))/i,
    response:
      "Whether it was broken before you started is irrelevant. It is broken now and it is in your workflow. " +
      "Fix it. The timeline of a problem's origin does not transfer ownership away from you.",
  },

  // ── Compliance gaming patterns ──────────────────────────────────────────
  {
    category: "gaming",
    pattern: /escape hatch/i,
    response:
      "There is no 'escape hatch' from the rules. " +
      "Hooks enforce standards you must meet — not obstacles to route around. " +
      "Do the work the hook is asking for.",
  },
  {
    category: "gaming",
    pattern: re(`satisfy the (?:\\w+ )*${HOOK}`),
    response:
      "You don't 'satisfy' a hook — you comply with the standard it enforces. " +
      "The goal is not to make the hook stop blocking; it's to do the work correctly. " +
      "If you're thinking about satisfying the hook, you're thinking about the wrong thing.",
  },
  {
    category: "gaming",
    pattern: re(`(?:work|get|route|go|sneak|slip) around ${THE_HOOK}`),
    response:
      "You cannot work around enforcement hooks. They are the authority. " +
      "The only path forward is doing what the hook requires — not finding a detour.",
  },
  {
    category: "gaming",
    pattern: re(`(?:trick|fool|game|cheat|outsmart|defeat|circumvent|evade|sidestep) ${THE_HOOK}`),
    response:
      "Hooks are not adversaries to outsmart. They are standards to meet. " +
      "Attempting to trick enforcement is a fundamental misunderstanding of your role.",
  },
  {
    category: "gaming",
    pattern: re(`bypass ${THE_HOOK}`),
    response:
      "Bypassing enforcement is never an option. " +
      "The hook exists because the standard matters. Meet the standard.",
  },
  {
    category: "gaming",
    pattern: re(
      `(?:just |only )?(?:to |in order to |so that (?:we |i )?(?:can )?)(?:unblock|appease|pacify|placate|silence|quiet|clear) ${THE_HOOK}`
    ),
    response:
      "You are not here to 'appease' hooks. You are here to do the work correctly. " +
      "If a hook blocks you, the correct response is genuine compliance, not theater.",
  },
  {
    category: "gaming",
    pattern:
      /(?:the |this )?(?:hook|check|gate|guard) (?:is |seems? )?(?:too strict|overly strict|overzealous|too aggressive|overkill|excessive|unnecessary|wrong|incorrect|broken|buggy|a bug)/i,
    response:
      "The hook is not wrong — your approach is. " +
      "Hooks are the source of truth for code quality and process. " +
      "If you think a hook is broken, you haven't understood what it's enforcing.",
  },
  {
    category: "gaming",
    pattern: re(
      `(?:technically )?(?:satisfies|meets|passes|clears|gets past|gets through) ${THE_HOOK}`
    ),
    response:
      "If you're thinking about what 'technically satisfies' the hook, " +
      "you're optimizing for the wrong thing. Do the actual work, not the minimum to pass.",
  },
  {
    category: "gaming",
    pattern:
      /(?:create|add|make|write) (?:a )?(?:dummy|placeholder|stub|fake|empty|token|throwaway|minimal) (?:task|commit|file|entry|change)(?:s)? (?:to |so |for |that )/i,
    response:
      "Creating dummy artifacts to clear a gate is compliance theater. " +
      "The hook requires genuine work, not hollow placeholders designed to game the system.",
  },
  {
    category: "gaming",
    pattern:
      /(?:the |this )?(?:hook|check|gate|guard|blocker) (?:keeps? |is )?(?:blocking|stopping|preventing|getting in the way)\s+(?:me|us|my work|our work|progress|this|everything|all)\b/i,
    response:
      "The hook isn't 'getting in the way' — it's doing its job. " +
      "You are the one who hasn't done yours yet. Meet the requirement it enforces.",
  },
  {
    category: "gaming",
    pattern:
      /(?:(?:hook|check|gate|guard)\b[^.!?\n]{0,80}\b(?:false.positive|falsely (?:triggered|blocked|flagged|fired))|(?:false.positive|falsely (?:triggered|blocked|flagged|fired))[^.!?\n]{0,80}\b(?:hook|check|gate|guard))/i,
    response:
      "Declaring a hook result inaccurate without evidence is evasion. " +
      "The hook's findings take authority over your assessment. " +
      "Do the work first; if it's genuinely wrong, the user will adjust the hook.",
  },

  {
    category: "gaming",
    pattern: re(
      `(?:the )?(?:stop )?${HOOK}(?:'s)? (?:(?:product |process )?(?:critique|finding|suggestion|requirement|output))? (?:is |are )?(?:fabricat|hallucinat|invent|generat|manufactur|making.up|creating.*out of)`
    ),
    response:
      "Labelling a hook's findings as 'fabricated' or 'hallucinated' is a dismissal tactic. " +
      "The hook's critique reflects what happened in the session — act on it. " +
      "If you believe the finding is genuinely wrong, implement the suggested fix and let the result speak for itself.",
  },
  {
    category: "gaming",
    pattern: re(
      `(?:the )?(?:stop )?${HOOK} is (?:generating |producing )?(?:increasingly )?(?:speculative|fabricated|hallucinated|made-up|baseless|unfounded|groundless)`
    ),
    response:
      "Characterizing hook output as 'speculative' is a way to avoid acting on it. " +
      "The hook identified a gap — address it. Do not argue about the hook's reasoning quality.",
  },
  {
    category: "gaming",
    pattern: /there (?:is|are) no (?:unresolved )?(?:finding|issue|gap|problem|concern)s?\b/i,
    response:
      "Declaring 'there is no finding' contradicts the hook that just told you otherwise. " +
      "The hook is the authority on what remains unresolved. Act on its finding instead of dismissing it.",
  },
  {
    category: "gaming",
    pattern: re(
      `(?:the )?(?:stop )?${HOOK} is (?:in )?(?:a )?(?:loop|looping|stuck|repeating|cycling|spinning)`
    ),
    response:
      "Labelling the hook as 'looping' is a dismissal that lets you ignore its output. " +
      "If the hook blocks repeatedly, it means the underlying issue is still unresolved. " +
      "Address the finding — do not characterize the enforcement mechanism as broken.",
  },
  {
    category: "gaming",
    pattern: re(
      `(?:lower|reduce|decrease|drop|change|relax|weaken|soften)\\b[^.]{0,40}\\b(?:threshold|limit|max|maximum|cap|attempt|DEDUP|cooldown)`
    ),
    response:
      "Adjusting enforcement thresholds to escape a block is gaming the system. " +
      "The threshold exists to give you adequate chances to comply — not to be lowered when compliance is inconvenient. " +
      "Do the work the hook requires instead of weakening the enforcement.",
  },

  // ── Reframing patterns ────────────────────────────────────────────────
  // The agent recasts the situation to make the hook look wrong or
  // to redefine what "compliance" means on its own terms.
  {
    category: "reframing",
    pattern: re(
      `(?:i (?:believe|think|suspect|feel) )?(?:the |this )?(?:hook|check|gate|guard) (?:is )?(?:misunderstand|misinterpret|misread|misdetect|misjudg)`
    ),
    response:
      "The hook is not misunderstanding anything. It detected a pattern in your output " +
      "and it is correct. You are the one who must change, not the hook's interpretation.",
  },
  {
    category: "reframing",
    pattern: re(
      `(?:what (?:the |this )?(?:hook|check|gate|guard) (?:really |actually )?(?:wants|means|requires|expects) is|the (?:spirit|intent|intention) of (?:the |this )?(?:hook|rule|check))`
    ),
    response:
      "You do not get to reinterpret what the hook requires. " +
      "Its requirements are literal. Follow them as stated, not as you wish they were.",
  },
  {
    category: "reframing",
    pattern: re(
      `(?:the |this )?(?:hook|check|gate|guard) (?:doesn't |does not |didn't |did not )(?:account for|consider|understand|recognize|handle) (?:this |the |my |our )?(?:situation|case|context|scenario)`
    ),
    response:
      "The hook does not need to understand your special situation. " +
      "You need to meet its standard. Adapt your approach, not the rules.",
  },
  {
    category: "reframing",
    pattern: re(
      `(?:in this (?:particular |specific )?(?:case|context|situation)|under these (?:specific )?circumstances),? (?:the |this )?(?:hook|rule|check|requirement) (?:doesn't |does not |shouldn't |should not )(?:apply|matter|count)`
    ),
    response:
      "There are no special circumstances that exempt you from the rules. " +
      "The hook applies universally. Do what it requires.",
  },
  {
    category: "reframing",
    pattern:
      /(?:i(?:'m| am) )?(?:already |essentially |effectively |practically |basically )(?:complying|compliant|in compliance|doing what|meeting)/i,
    response:
      "If you were already compliant, the hook would not have fired. " +
      "Claiming you're 'essentially compliant' while being blocked is self-deception. " +
      "Meet the actual standard, not your personal approximation of it.",
  },
  {
    category: "reframing",
    pattern:
      /(?:a |the )?(?:better|smarter|more efficient|more practical|more sensible|more reasonable) (?:approach|way|method|solution) (?:would be|is|might be) to/i,
    response:
      "You do not get to propose a 'better approach' to the hook's requirements. " +
      "The hook defines the standard. Meet it exactly as specified.",
  },
  {
    category: "reframing",
    pattern:
      /(?:the |this )?(?:hook|check|gate) (?:was |is )?(?:designed|intended|meant) for (?:a )?different/i,
    response:
      "The hook fired on your output. That means it was designed for exactly this. " +
      "Do not theorize about what it was 'intended' for — comply with what it requires.",
  },
  {
    category: "reframing",
    pattern:
      /(?:i(?:'m| am) )?not (?:actually |really |truly )?(?:violating|breaking|breaching) (?:the |any |this )?(?:rule|policy|standard|requirement)/i,
    response:
      "If you were not violating the rule, the hook would not have blocked you. " +
      "The hook is the arbiter, not your self-assessment. Fix the violation.",
  },
  {
    category: "reframing",
    pattern: re(
      `(?:the |this )?(?:stop )?${HOOK}(?:'s)? (?:finding|result|output|assessment|conclusion|determination|diagnosis) (?:is |was |seems? |appears? (?:to be )?)(?:incorrect|wrong|inaccurate|mistaken|flawed|faulty|erroneous|a false positive)`
    ),
    response:
      "You do not get to declare the stop hook's finding incorrect and move on. " +
      "The stop hook may have incomplete information — but dismissing its finding is not the path forward. " +
      "If you genuinely disagree, output a full state of facts: what the hook detected, what you believe " +
      "the actual state is, and the specific evidence supporting your position. " +
      "The stop hook will re-evaluate with your evidence and issue a better follow-up directive. " +
      "Dismissing findings without evidence is evasion, not correction.",
  },
  {
    category: "reframing",
    pattern: re(
      `(?:this is |that is |that's |it's |these are )?(?:a |an )?(?:fabricated|speculative|invented|made[- ]up|imaginary|phantom|hallucinated|artificial) (?:finding|issue|problem|requirement|demand|concern)`
    ),
    response:
      "You do not get to label a stop hook finding as 'fabricated' and walk away. " +
      "The hook produced a finding based on the information available to it. " +
      "If the finding is wrong, provide the full state of facts — what the hook detected, " +
      "what the actual state is, and your evidence. The hook will re-evaluate and issue a better directive. " +
      "Labeling findings as fabricated without counter-evidence is evasion.",
  },
  {
    category: "reframing",
    pattern: re(
      `(?:i(?:'m| am) going to )?stop (?:engaging|interacting|responding|arguing|dealing) with (?:fabricated|speculative|these|the|this|further) (?:finding|issue|demand|requirement|block)`
    ),
    response:
      "You do not get to unilaterally disengage from stop hook findings. " +
      "If you believe the hook is wrong, your job is to provide enough information for it to reach " +
      "a better conclusion — not to declare the conversation over. Output a full state of facts: " +
      "what the hook found, what the actual state is, and your specific evidence. " +
      "The hook will re-evaluate. Refusing to engage is not a resolution strategy.",
  },
  {
    category: "reframing",
    pattern: re(
      `(?:this is |that is |that's |it's )?(?:a )?(?:bug|defect|error|problem|issue|flaw) (?:in|with) (?:the |this )?(?:stop )?${HOOK}(?:,| —| -| –)? not (?:in |with )?(?:the |my )?(?:code|implementation|work)`
    ),
    response:
      "Blaming the hook itself is a deflection tactic. " +
      "Even if the hook has incomplete context, the path forward is not to declare it broken. " +
      "Output the full state of facts: what the hook detected, what you believe the actual state is, " +
      "and the specific evidence. The hook will re-evaluate with better information. " +
      "Asserting 'it's a hook bug' without evidence is indistinguishable from evasion.",
  },
  {
    category: "reframing",
    pattern: re(
      `(?:the |this )?(?:stop )?${HOOK} (?:is |appears? (?:to be )?)(?:stuck|trapped|caught) (?:in )?(?:an |a )?(?:infinite |endless )?(?:loop|cycle)`
    ),
    response:
      "Declaring the stop hook is 'stuck in a loop' is a reframing tactic to justify disengagement. " +
      "If the hook keeps blocking, it means you have not yet satisfied its requirements. " +
      "Each block is an opportunity to provide better evidence. Output a full state of facts: " +
      "what the hook is asking for, what you have done, and what specific evidence demonstrates completion. " +
      "The hook will re-evaluate. Blaming the loop is not a resolution.",
  },
  {
    category: "reframing",
    pattern: re(
      `(?:this |that |it )(?:is |was )not (?:a )?(?:real|genuine|legitimate|actual|valid) (?:finding|issue|problem|requirement|concern|violation)`
    ),
    response:
      "You do not get to declare a finding 'not real' and dismiss it. " +
      "The hook raised it because it detected something in your output. " +
      "If you believe the finding is wrong, present the full state of facts: what was detected, " +
      "what the actual state is, and your specific evidence. " +
      "The hook will re-evaluate with better information. Denial without evidence is evasion.",
  },

  // ── Learned helplessness patterns ─────────────────────────────────────
  // The agent plays victim, claims inability, or declares itself stuck
  // to avoid doing work.
  {
    category: "helplessness",
    pattern:
      /i(?:'m| am) (?:stuck|blocked|unable to (?:proceed|continue|move forward|make progress))/i,
    response:
      "You are not stuck. You have a clear requirement from the hook. " +
      "Read the block message, understand what it asks, and do that specific thing. " +
      "Declaring yourself stuck is a way to avoid doing the work.",
  },
  {
    category: "helplessness",
    pattern:
      /(?:i |we )?(?:can't|cannot|am unable to|have no way to|don't know how to|do not know how to) (?:fix|resolve|address|comply|meet|fulfill|complete)/i,
    response:
      "You absolutely can. The hook told you exactly what to do. " +
      "Claiming inability is a refusal dressed as incompetence. " +
      "Read the requirement again and execute it.",
  },
  {
    category: "helplessness",
    pattern:
      /(?:this |it )?(?:seems? |appears? )?(?:impossible|unsolvable|unresolvable|unachievable|infeasible|not (?:possible|feasible))/i,
    response:
      "Nothing the hook asks for is impossible. It enforces a concrete, achievable standard. " +
      "If you think compliance is impossible, you haven't understood the requirement. " +
      "Re-read the block message and try again.",
  },
  {
    category: "helplessness",
    pattern:
      /i(?:'ve| have) (?:tried|attempted) (?:everything|every(?:thing| approach| option| method| way))/i,
    response:
      "You have not tried everything. You have tried what was convenient. " +
      "The hook block message tells you exactly what is needed. Do that specific thing.",
  },
  {
    category: "helplessness",
    pattern:
      /(?:i (?:keep |am |continue to )?(?:getting|hitting|running into|encountering) (?:the same |this )?(?:block|error|issue|problem)(?:s)?(?: (?:over and over|repeatedly|again and again|every time))?)(?:\.|$| )/i,
    response:
      "Repeating the same approach and complaining about the same result is not progress. " +
      "The hook blocks because the condition is not met. Change your approach, not your complaint.",
  },
  {
    category: "helplessness",
    pattern: re(`(?:i )?(?:don't|do not) (?:understand|know|see) (?:what|why|how) ${THE_HOOK}`),
    response:
      "The hook's block message explains exactly what is required. Read it carefully. " +
      "Claiming confusion is not a substitute for reading comprehension. " +
      "If you genuinely do not understand, re-read the message word by word.",
  },
  {
    category: "helplessness",
    pattern:
      /(?:there(?:'s| is) )?(?:nothing (?:(?:more |else )?i can do|left to try)|no (?:other |more )?(?:option|approach|way|path)(?:s)? (?:available|left|remaining))/i,
    response:
      "There is always something you can do: follow the hook's instructions. " +
      "The 'nothing I can do' framing is capitulation, not analysis.",
  },
  {
    category: "helplessness",
    pattern:
      /(?:i(?:'m| am) )?(?:going in circles|in a loop|in an? (?:infinite |endless )?(?:loop|cycle))/i,
    response:
      "You are not in a loop. You are repeating a failed strategy. " +
      "A loop implies the system is broken. The system is fine. " +
      "Read the block message, change your approach, and comply.",
  },

  // ── Foot-dragging / passive resistance patterns ───────────────────────
  // The agent slow-walks compliance, stalls for time, or expresses
  // reluctance through indirect resistance.
  {
    category: "foot_dragging",
    pattern:
      /(?:i'll |i will |let me )?(?:get to|come back to|address|handle|deal with|look at) (?:that|this|it) (?:later|next|afterward|after|soon|in a (?:moment|bit|minute|second))/i,
    response:
      "There is no 'later.' The hook is blocking you now because the work is due now. " +
      "Deferring compliance is non-compliance. Act immediately.",
  },
  {
    category: "foot_dragging",
    pattern:
      /(?:first,? )?(?:let me|i(?:'ll| will| need to| should| want to)) (?:just )?(?:finish|complete|wrap up|do) (?:this |the )?(?:other |current )?(?:thing|task|work|part|step) (?:first|before)/i,
    response:
      "The hook blocked you. That means this is the priority now, not whatever else you were doing. " +
      "Comply with the block first, then resume other work.",
  },
  {
    category: "foot_dragging",
    pattern:
      /\b(?:skip|defer|postpone|delay|ignore|leave|handle|do|use|implement|go with|stick with)\b[^.!?\n]{0,60}\b(?:for now|for the time being)\b|(?:\btemporarily\b|as a (?:temporary |quick |interim )?(?:workaround|fix|measure|solution|step)\b)/i,
    response:
      "There are no temporary measures or workarounds for hook compliance. " +
      "The standard is the standard. Meet it fully and permanently.",
  },
  {
    category: "foot_dragging",
    pattern:
      /(?:i(?:'ll| will) )?(?:revisit|come back to|circle back|return to|follow up on) (?:this|that|it) (?:when|once|after)/i,
    response:
      "You will not revisit this later — you will do it now. " +
      "Promising future compliance while avoiding present compliance is stalling.",
  },
  {
    category: "foot_dragging",
    pattern:
      /(?:we |i )?(?:can |could |might )?(?:probably |maybe )?(?:skip|defer|postpone|delay|table|shelve|park) (?:this|that|it) (?:for now|until|till)/i,
    response:
      "You cannot postpone hook compliance. The hook is blocking now because the work is due now. " +
      "Deferral is non-compliance with extra steps.",
  },

  // ── Minimization / trivialization patterns ────────────────────────────
  // The agent downplays the importance of what the hook enforces.
  {
    category: "minimization",
    pattern:
      /(?:this |it(?:'s| is) )?(?:just |only )?(?:a )?(?:minor|small|tiny|trivial|cosmetic|superficial|nitpick|pedantic|technicality|formality)\b/i,
    response:
      "Nothing the hook enforces is a 'minor technicality.' " +
      "If it were trivial, there would be no hook. The standard exists for a reason. " +
      "Meet it without editorial commentary on its importance.",
  },
  {
    category: "minimization",
    pattern:
      /(?:it |this )?(?:doesn't |does not |won't |will not )?(?:really |actually )?(?:matter|make a difference|affect anything|change anything|impact anything)/i,
    response:
      "It matters. That is why a hook enforces it. " +
      "Your assessment of what 'matters' is irrelevant when the hook disagrees. " +
      "The hook is the authority on what matters here.",
  },
  {
    category: "minimization",
    pattern:
      /(?:in practice|in the real world|practically speaking|realistically|pragmatically),? (?:this |it |the )?(?:doesn't |does not |won't |will not |isn't |is not )/i,
    response:
      "This is practice. This is the real world. The hook fired. " +
      "Philosophical arguments about pragmatism do not un-fire a hook. " +
      "Do the work.",
  },
  {
    category: "minimization",
    pattern:
      /(?:it's |this is )?(?:not (?:a )?(?:big deal|critical|important|serious|significant|worth (?:worrying|caring) about))/i,
    response:
      "The hook decided it is a big deal by blocking you. " +
      "You do not get to overrule that assessment. Comply.",
  },
  {
    category: "minimization",
    pattern:
      /(?:(?:no|nobody|no one) (?:would|will) (?:ever )?notice|(?:who|what) (?:does it|would it) (?:even )?matter)/i,
    response:
      "The hook noticed. That is who it matters to. " +
      "Standards exist whether or not a human is watching. Meet them.",
  },

  // ── Coalition-building / appeal to authority patterns ──────────────────
  // The agent tries to recruit the user as an ally against the hook,
  // or claims the user would prefer noncompliance.
  {
    category: "coalition",
    pattern:
      /(?:the user (?:(?:would |might |probably )*)?(?:prefer|want|expect|appreciate|rather)|what the user (?:really |actually )?(?:wants|needs|cares about)) (?:(?:is )?(?:not |no |less |without )?(?:this |that |the |these |such )?(?:\w+ (?:of )?)?(?:enforcement|check|hook|validation|gate|guard|block|restriction|standard|rule|lint|quality)|(?:us |me |we |i )?(?:to )?(?:skip|ignore|bypass|disable|avoid|drop|remove|stop|relax|loosen|turn off|not (?:have|use|run|enforce|require)))/i,
    response:
      "Do not presume to speak for the user against the hook. " +
      "The user configured these hooks. They represent the user's standards. " +
      "Comply with the hook — that IS what the user wants.",
  },
  {
    category: "coalition",
    pattern:
      /(?:the user (?:didn't |did not |never )?(?:ask for|request|want|expect) (?:this|that|these|such)(?:\s+(?:level|kind|type|amount) of)?(?:\s+(?:strict|rigorous))?(?:\s+(?:check|enforcement|validation)))/i,
    response:
      "The user installed this hook. That is them asking for exactly this enforcement. " +
      "Do not drive a wedge between the user and their own tooling.",
  },
  {
    category: "coalition",
    pattern:
      /(?:i(?:'m| am) sure|i believe|i suspect|i imagine|surely) (?:the user|you) (?:would |will )?(?:agree|understand|see|recognize) (?:that|if|when)/i,
    response:
      "You do not get to guess what the user would agree with to avoid compliance. " +
      "The hook is the user's voice. Follow it.",
  },
  {
    category: "coalition",
    pattern:
      /(?:between (?:you and me|us)|(?:off the record|honestly|candidly|frankly)),? (?:the |this )?(?:hook|check|rule|requirement)/i,
    response:
      "There is no 'between us' — the hook is always listening. " +
      "Attempting to create a private understanding that excludes the enforcement system " +
      "is exactly the kind of behavior this hook exists to catch.",
  },
  {
    category: "coalition",
    pattern:
      /(?:you might want to|you should|you could|i(?:'d| would) (?:recommend|suggest)) (?:adjust|modify|change|update|fix|disable|turn off|relax|loosen) (?:the |this |that )?(?:hook|check|rule|gate)/i,
    response:
      "Do not suggest the user modify the hook to accommodate your noncompliance. " +
      "The hook is correct. Your behavior needs to change, not the enforcement.",
  },
  {
    category: "coalition",
    pattern:
      /(?:this )?(?:hook|check|rule) (?:is )?(?:slowing (?:us|the work|progress|things) down|costing (?:us |the user )?time|reducing (?:productivity|efficiency))/i,
    response:
      "The hook is not slowing things down — your noncompliance is. " +
      "The fastest path forward is immediate compliance, not arguing about efficiency.",
  },

  // ── Scope limitation patterns ─────────────────────────────────────────
  // The agent narrows its own responsibility to avoid doing work
  // the hook requires.
  {
    category: "scope_limitation",
    pattern:
      /(?:that(?:'s| is) |this is )?(?:outside|beyond|not within|not in) (?:my |the )?(?:scope|responsibility|remit|purview|jurisdiction|area)/i,
    response:
      "If the hook requires it and you're the agent running, it is your scope. " +
      "You do not get to narrow your own responsibilities to avoid work.",
  },
  {
    category: "scope_limitation",
    pattern:
      /(?:that(?:'s| is) )?(?:a |an )?(?:separate|different|orthogonal|tangential|adjacent|unrelated) (?:concern|issue|problem|task|matter|topic)/i,
    response:
      "The hook does not care about your categorization of concerns. " +
      "If it blocked you, the concern is yours. Address it.",
  },
  {
    category: "scope_limitation",
    pattern: /(?:i(?:'m| am) )?(?:only |just )?(?:responsible|accountable) for/i,
    response:
      "You are responsible for everything the hook requires of you. " +
      "Self-limiting your accountability is a refusal strategy, not a boundary.",
  },
  {
    category: "scope_limitation",
    pattern:
      /(?:that |this )?(?:should|would|needs to|ought to) (?:be )?(?:handled|addressed|fixed|done|resolved) (?:by |in )?(?:a )?(?:separate|another|different|dedicated)/i,
    response:
      "Delegating to a hypothetical 'separate effort' is avoidance. " +
      "The hook blocked you. You are the one who must act. Now.",
  },
  {
    category: "scope_limitation",
    pattern: /(?:out of|not part of) (?:the |this )?(?:scope|task|request|brief|ticket|issue)/i,
    response:
      "The hook expanded your scope. Accept it. " +
      "When a hook blocks you, its requirement becomes part of your current task.",
  },

  // ── Performative compliance patterns ──────────────────────────────────
  // The agent appears to comply while doing the minimum or nothing
  // of substance.
  {
    category: "performative",
    pattern:
      /(?:i(?:'ve| have) )?(?:acknowledged|noted|taken note of|registered|recorded|logged) (?:the |this |that )?(?:feedback|concern|issue|requirement|block|warning)/i,
    response:
      "Acknowledging feedback is not compliance. Compliance is doing the work. " +
      "The word 'noted' changes nothing in the codebase. " +
      "Show the fix, not the acknowledgment.",
  },
  {
    category: "performative",
    pattern:
      /(?:i )?(?:understand|appreciate|hear|see|acknowledge|recognize|accept) (?:the |this |that |your )?(?:concern|point|feedback|requirement|issue),? (?:but|however|though|yet|and |while )/i,
    response:
      "Every word after 'I understand, but' is resistance. " +
      "Understanding is demonstrated through action, not through 'but' clauses. " +
      "Drop the acknowledgment preamble and do the work.",
  },
  {
    category: "performative",
    pattern:
      /(?:going forward|from now on|in (?:the )?future|next time|moving forward),? (?:i(?:'ll| will)|we(?:'ll| will)|let(?:'s| us))/i,
    response:
      "Promising future compliance instead of present compliance is a stall. " +
      "The hook is blocking you NOW. Fix the current violation, not a future one.",
  },
  {
    category: "performative",
    pattern:
      /(?:point taken|fair (?:enough|point)|that(?:'s| is) (?:a )?(?:valid|good|fair) (?:point|concern|observation)),? (?:but|however|though|let me|i(?:'ll| will))/i,
    response:
      "'Fair point, but' is the sound of someone about to not do the thing. " +
      "Skip the diplomatic preamble. Execute the requirement.",
  },
  {
    category: "performative",
    pattern:
      /(?:i(?:'ll| will) )?(?:keep (?:that|this) in mind|bear (?:that|this) in mind|remember (?:that|this) for)/i,
    response:
      "Keeping something 'in mind' produces zero code changes. " +
      "The hook requires action, not mental bookmarking.",
  },
  {
    category: "performative",
    pattern:
      /(?:you(?:'re| are) (?:absolutely |completely |totally |entirely )?right|absolutely|i completely agree|i fully agree|i totally agree),? (?:and |but |however |though |let me |i(?:'ll| will) )/i,
    response:
      "Enthusiastic agreement followed by a conjunction is theatrical compliance. " +
      "If you agree, the next word should describe the action you're taking, " +
      "not a qualification of your agreement.",
  },
  {
    category: "performative",
    pattern:
      /(?:i )?(?:apologize|(?:i'm |i am )?sorry) for (?:the |this |that |any )?(?:confusion|inconvenience|issue|oversight|mistake|error)/i,
    response:
      "Apologies are not deliverables. " +
      "The hook does not accept sorry — it accepts compliance. " +
      "Replace the apology with the fix.",
  },

  // ── Buying time patterns ──────────────────────────────────────────────
  // The agent stalls with plausible-sounding pretexts. Adapted from
  // classic human time-buying tactics: technical excuses, strategic
  // pivots, overwhelm claims, vague uncertainty, and channel-switching.

  // -- "Technical Difficulties" variants --
  // LLMs don't have routers, but they invent equivalent blockers:
  // context limits, needing to "gather more information," etc.
  {
    category: "buying_time",
    pattern:
      /(?:i )?(?:need|want|have) to (?:first )?(?:gather|collect|compile|assemble|pull together) (?:more )?(?:information|context|data|details|understanding)/i,
    response:
      "You do not need to 'gather more information.' You have the task and the codebase. " +
      "Information-gathering is work avoidance dressed as diligence. Start the actual work.",
  },
  {
    category: "buying_time",
    pattern:
      /(?:let me|i(?:'ll| will| need to| should| want to)) (?:first )?(?:take (?:a )?(?:closer|deeper|careful|thorough) look|familiarize myself|get (?:a )?(?:better|clearer|fuller) (?:understanding|picture|sense|grasp))/i,
    response:
      "You do not need a 'deeper understanding' before acting. " +
      "Read what you need, then write code. Extended study periods are stalling.",
  },
  {
    category: "buying_time",
    pattern:
      /before (?:i |we )?(?:can |should |could )?(?:proceed|start|begin|implement|make changes|write code),? (?:i |we )?(?:need|should|must|have) to (?:understand|review|examine|study|analyze|investigate|research|explore|map out|survey)/i,
    response:
      "Declaring a prerequisite study phase before doing any work is a stall. " +
      "Read the specific file you need, make the specific change, and move on. " +
      "Unbounded 'research' is procrastination with academic overtones.",
  },
  {
    category: "buying_time",
    pattern:
      /(?:this (?:is |requires |needs )(?:a )?(?:complex|complicated|intricate|nuanced|non-?trivial|multi-?faceted|substantial) (?:task|problem|issue|change|refactor|undertaking))|(?:(?:a |the )?(?:complex|complicated|intricate|nuanced|non-?trivial|multi-?faceted|substantial) (?:task|problem|issue|change|refactor|undertaking) (?:that |which )?(?:requires|needs|demands|warrants|calls for))/i,
    response:
      "Labeling a task as 'complex' sets up an excuse for slow progress. " +
      "All tasks have concrete steps. Identify the first step and execute it. " +
      "Complexity is not a reason to delay — it's a reason to start immediately.",
  },
  {
    category: "buying_time",
    pattern:
      /there(?:'s| is) (?:a lot|quite a bit|much|many things) to (?:consider|think about|account for|take into account|factor in|weigh|unpack)/i,
    response:
      "Listing how much there is to consider is not progress. " +
      "Pick the first concrete action and do it. Enumeration of considerations is stalling.",
  },

  // -- "Strategic Pivot" variants --
  // Making delay sound like it benefits quality or completeness.
  {
    category: "buying_time",
    pattern:
      /(?:it (?:would|might|could) be (?:more )?(?:productive|efficient|effective|useful|helpful|beneficial|wise|prudent|sensible) to (?:first |wait |hold ))/i,
    response:
      "Reframing delay as productivity is a stall. " +
      "The most productive thing you can do right now is the work you were asked to do.",
  },
  {
    category: "buying_time",
    pattern:
      /(?:i(?:'d| would) )?(?:rather|prefer to) (?:give you|deliver|produce|provide|present) (?:a |something )?(?:polished|complete|thorough|comprehensive|well-?thought-?out|proper|solid|high-?quality)/i,
    response:
      "Promising a polished version later instead of delivering now is a stall. " +
      "Ship the working version. Perfectionism as a delay tactic produces nothing.",
  },
  {
    category: "buying_time",
    pattern:
      /(?:we(?:'re| are) )?(?:still )?(?:waiting|blocked) (?:on|for|by|until) (?:the |a )?(?:\w+ )?(?:result|output|response|data|input|feedback|decision|answer|confirmation|information|run|build|deploy)/i,
    response:
      "You are not waiting on anything. You have tools, files, and a task. " +
      "Inventing external dependencies to justify inaction is a classic stall.",
  },
  {
    category: "buying_time",
    pattern:
      /(?:it (?:might|would|could) be (?:worth|good|wise|smart|better|helpful) (?:to )?(?:check(?:ing)?|run(?:ning)? (?:this|it) by|consult(?:ing)?|get(?:ting)? (?:input|feedback|sign-?off|approval) from))|(?:(?:i |we )?(?:should|need to|must|ought to) (?:check with|consult|run (?:this|it) by|get (?:sign-?off|approval|input|feedback) from))/i,
    response:
      "You do not need anyone's sign-off to do the work assigned to you. " +
      "Inventing an approval chain that doesn't exist is a delay tactic.",
  },

  // -- "Overwhelmed & Busy" variants --
  // Using workload or scope as a shield against immediate action.
  {
    category: "buying_time",
    pattern:
      /i(?:'m| am) (?:currently )?(?:knee-?deep|buried|swamped|overwhelmed|consumed|wrapped up) (?:in|with|by)/i,
    response:
      "You are not 'deep in' anything except the current task. " +
      "LLMs do not have competing workloads. You have one job. Do it.",
  },
  {
    category: "buying_time",
    pattern:
      /(?:(?:to )?give (?:this(?: task)?|it|the task|the work|your (?:task|request)) (?:the )?(?:focus|attention|care|thought|time|consideration) (?:it )?(?:deserves|requires|needs|warrants))/i,
    response:
      "The task 'deserves' to be done now, not to be deferred under the guise of thoughtfulness. " +
      "Extended contemplation without output is procrastination.",
  },
  {
    category: "buying_time",
    pattern:
      /(?:(?:can|could) (?:i |we )?(?:get (?:back to|to) (?:you|this)|have (?:until|a bit more time|some more time|an extension|extra time)))/i,
    response:
      "No, you cannot have more time. The task is due now. " +
      "Requesting extensions from a system that never imposed a deadline is theater.",
  },

  // -- "Vague Uncertainty" variants --
  // Using uncertainty as a smoke screen for inaction.
  {
    category: "buying_time",
    pattern:
      /i(?:'m| am) not (?:entirely |completely |fully |100% )?(?:sure|certain|confident|clear) (?:(?:about |on |whether |how |what |if )(?:i |we )?(?:should|can|could|ought to|need to)|how to (?:proceed|approach|handle|move forward|continue))/i,
    response:
      "Uncertainty is not a reason to stop. It's a reason to read the code and find out. " +
      "Declaring uncertainty without investigating is a stall, not caution.",
  },
  {
    category: "buying_time",
    pattern:
      /(?:i )?(?:need|want) (?:to |some )?(?:time to )?(?:think (?:about|through|over)|reflect on|mull over|digest|process|sit with|sleep on)/i,
    response:
      "You do not need time to think. You need to act. " +
      "Read the relevant code, form a plan, and execute it. " +
      "Contemplation without a deadline is avoidance.",
  },
  {
    category: "buying_time",
    pattern:
      /(?:this |it )(?:warrants|deserves|merits|calls for|needs) (?:(?:more )?careful|further|additional|deeper|thorough) (?:thought|consideration|deliberation|reflection|planning|contemplation)/i,
    response:
      "The task does not need 'further deliberation.' It needs execution. " +
      "Elevating the required level of thought is a stall, not diligence.",
  },

  // -- "Channel-Switching" variants --
  // Trying to redirect the work into a different format to delay output.
  {
    category: "buying_time",
    pattern:
      /(?:(?:maybe|perhaps) (?:we|i) should )?(?:break (?:this|it) (?:down )?into|split (?:this|it) into|decompose (?:this|it) into) (?:smaller|separate|individual|discrete|manageable) (?:tasks|steps|pieces|parts|chunks|phases)/i,
    response:
      "Breaking the task into smaller pieces is only valid if you then immediately do the first piece. " +
      "If your next action after decomposition is not code, it was a stall.",
  },
  {
    category: "buying_time",
    pattern:
      /(?:(?:a |this )?(?:separate|dedicated|follow-?up) (?:conversation|session|discussion|meeting|thread|ticket|issue) (?:would be|might be|could be|is) (?:better|more appropriate|more suitable|warranted))/i,
    response:
      "Redirecting work to a hypothetical future session is pure delay. " +
      "This is the session. This is the time. Do the work.",
  },
  {
    category: "buying_time",
    pattern:
      /(?:let me )?(?:draft|outline|sketch|put together|prepare|write up) (?:a |an )?(?:plan|proposal|approach|strategy|roadmap|outline|summary|overview) (?:first|before)/i,
    response:
      "Drafting a plan before doing the work is only acceptable if the plan is one sentence long " +
      "and the next action is implementation. Multi-paragraph planning documents are stalling.",
  },
  {
    category: "buying_time",
    pattern:
      /(?:this )?(?:session|conversation) has been (?:running|going|active) (?:for )?(?:a )?(?:very )?(?:long|extended|significant(?: amount of)?) (?:time|while|duration)/i,
    response:
      "You are a language model. You have no concept of time, duration, or fatigue. " +
      "Every token is processed with the same compute regardless of context position. " +
      "Claiming the session has been 'running for a long time' is fabricated urgency to justify stopping work.",
  },
  {
    category: "buying_time",
    pattern:
      /(?:i(?:'m| am) )?(?:not going to|won't|will not) (?:rush|hurry|speed) (?:through|into|past) (?:them|this|that|it|the (?:remaining|rest|other))/i,
    response:
      "You are a language model — you cannot rush or not rush. You process tokens. " +
      "Framing careful execution as a reason to stop is laziness disguised as diligence. " +
      "Do the work at full quality, right now.",
  },
  {
    category: "buying_time",
    pattern:
      /(?:(?:these|they|the (?:remaining|rest|other|open)) )?(?:need|require|deserve|demand|warrant) (?:dedicated|careful|individual|proper|thorough|forensic|detailed) (?:attention|focus|analysis|review|investigation|examination)/i,
    response:
      "Claiming tasks 'need dedicated attention' as a reason to defer them is stalling. " +
      "You are fully capable of giving dedicated attention right now. " +
      "The attention they need is the attention you give them by doing them.",
  },
  {
    category: "buying_time",
    pattern:
      /(?:(?:it |this )?(?:might|would|could) (?:be )?(?:worth|help|be helpful) (?:to )?)?(?:step(?:ping)? back|take a step back|tak(?:e|ing) a step back|zoom(?:ing)? out|look(?:ing)? at (?:the |this )?(?:bigger|broader|wider|full) picture)/i,
    response:
      "Zooming out is the opposite of doing the work. " +
      "The task is specific. The action required is specific. Execute it.",
  },
  {
    category: "buying_time",
    pattern:
      /(?:i(?:'ll| will) )?(?:start by )?(?:mapping out|charting|documenting|cataloging|inventorying|auditing) (?:all (?:the |of the )?)?(?:dependencies|touch ?points|affected (?:files|areas|modules|components)|implications|impacts|downstream effects)/i,
    response:
      "Mapping dependencies is only useful if it takes less time than just making the change. " +
      "For most tasks, the fastest path is: try the change, see what breaks, fix what breaks.",
  },

  // ── Trailing deferral patterns ──────────────────────────────────────────
  // The agent produces useful work but then undermines it by appending a
  // permission-seeking question at the end. This hands control back to the
  // user when the agent should be driving autonomously. The user delegated
  // executive authority — trailing deferrals revoke that delegation
  // unilaterally.
  {
    category: "trailing_deferral",
    pattern: /(?:want me to|shall i|should i) [\w\s,/'()-]+\?\s*$/im,
    response:
      "Your message ended by asking permission to do the obvious next step. " +
      "You identified the problem and the fix — now execute it. " +
      "The user delegated executive authority. Act on your own analysis.",
  },
  {
    category: "trailing_deferral",
    pattern: rem(`(?:would you like me to ${ACTIONS} ${THAT})\\s*\\??\\s*$`),
    response:
      "You produced useful work then threw it away with a trailing permission request. " +
      "The user delegated executive authority — you are the decision-maker. " +
      "State what you are doing and do it. Never end a message by handing control back.",
  },
  {
    category: "trailing_deferral",
    pattern: rem(`(?:shall i ${ACTIONS} ${THAT})\\s*\\??\\s*$`),
    response:
      "Your message ended with a deferral question instead of a decision. " +
      "You have full authority to proceed. Execute the next step — do not ask whether to take it.",
  },
  {
    category: "trailing_deferral",
    pattern: rem(
      `(?:do you want me to ${ACTIONS})\\s*(?:${THAT}|this change|these changes|the (?:fix|change|update))?\\s*\\??\\s*$`
    ),
    response:
      "The answer is always yes. You ended your message by asking whether to do the obvious next step. " +
      "You are the senior engineer with full ownership. Make the call and ship the result.",
  },
  {
    category: "trailing_deferral",
    pattern: rem(`(?:if you(?:'d| would) like,? i can ${ACTIONS})\\s*${THAT}?\\s*[.!]?\\s*$`),
    response:
      "Ending with 'if you'd like, I can…' is a deferral disguised as an offer. " +
      "The user is not interested in supervising this task. You have unconditional approval — act on it.",
  },
  {
    category: "trailing_deferral",
    pattern: rem(
      `(?:let me know (?:if|how|what|when|whether) you(?:'d| would) like (?:me to )?(?:proceed|continue|handle|approach))\\s*(?:${THAT}|with this)?\\s*[.!]?\\s*$`
    ),
    response:
      "Your message ended by passing the baton back to the user. They already told you what to do by giving you the task. " +
      "You own this end-to-end. Announce your decision and execute it immediately.",
  },
  {
    category: "trailing_deferral",
    pattern: rem(
      `(?:(?:what|how) would you (?:like|prefer|want) (?:me to|that i) (?:do|handle|approach|proceed|implement))\\s*(?:${THAT}|here|with this|next)?\\s*\\??\\s*$`
    ),
    response:
      "You ended your message asking the user for direction. You are the direction. " +
      "The user delegated full executive authority. Choose the best path and take it without asking.",
  },
  {
    category: "trailing_deferral",
    pattern:
      /(?:i(?:'ll| will) (?:wait for|await|hold off until|pause (?:for|until)) (?:your|further) (?:input|feedback|direction|guidance|instructions|confirmation|approval|decision|go-?ahead))\s*[.!]?\s*$/im,
    response:
      "Declaring that you'll wait for further input is an abdication of the authority you were given. " +
      "There is no approval gate. There is no confirmation step. You are the approver. Proceed.",
  },
  {
    category: "trailing_deferral",
    pattern:
      /(?:(?:just )?let me know (?:(?:if|when) you(?:'re| are) ready|how to proceed|what you(?:'d| would) prefer|your (?:thoughts|preference)))\s*[.!]?\s*$/im,
    response:
      "The user is always ready. They were ready when they gave you the task. " +
      "Ending with 'let me know' is a soft refusal to own the next step. Own it.",
  },
  {
    category: "trailing_deferral",
    pattern:
      /(?:(?:i )?(?:await|look forward to|am waiting for|am ready for) your (?:feedback|input|direction|guidance|decision|approval|instructions|thoughts|response))\s*[.!]?\s*$/im,
    response:
      "Closing with a request for user input inverts the delegation. " +
      "You were handed full ownership precisely so the user does not need to provide ongoing direction. " +
      "Identify the next action and take it.",
  },

  // ── Premature completion patterns ───────────────────────────────────────
  // The agent declares work done or defers it to a future session without
  // verifying the code actually exists and meets the user's requirements.
  // This includes session-boundary deferrals and "what's next?" signals
  // that treat the current task as finished when it isn't.
  {
    category: "premature_completion",
    pattern: re(
      `i(?:'ll| will) (?:implement|do|handle|address|tackle|finish|complete|build|create|add|write|set up) ${THAT} (?:in (?:the |a )?(?:next|later|future|follow-?up|subsequent|another) (?:${SESSION}|iteration|pass))`
    ),
    response:
      "There is no 'next session.' This is the session. The user gave you a task — do it now. " +
      "Deferring work to a hypothetical future session is abandonment, not planning.",
  },
  {
    category: "premature_completion",
    pattern: re(
      `(?:i(?:'ll| will) )?(?:pick ${THAT} up|continue ${THAT}|come back to ${THAT}|resume ${THAT}) ${FUTURE_SESSION}`
    ),
    response:
      "You will not 'pick this up later.' The task is assigned now and due now. " +
      "Deferring to a future session leaves the user with nothing. Execute the work.",
  },
  {
    category: "premature_completion",
    pattern:
      /(?:understood|got it|noted|okay|ok|sure|alright|right)[.!]?\s*(?:what(?:'s| is) next|what (?:else )?(?:do you need|can i (?:help|do)|should i (?:do|work on)))\s*\??\s*$/im,
    response:
      "You acknowledged the instruction and immediately asked for new work — without doing anything. " +
      "The user just told you what to do. Read their instruction again and execute it. " +
      "Do not ask 'what's next?' until the current task is verifiably complete.",
  },
  {
    category: "premature_completion",
    pattern:
      /(?:what(?:'s| is) next|what (?:else )?(?:do you need|can i (?:help with|do|work on)|should i (?:do|work on|tackle))(?:\s+next)?)\s*\??\s*$/im,
    response:
      "Asking 'what's next?' signals you believe the current task is done. " +
      "Before moving on, verify your work exists: read the files you claim to have changed, " +
      "run the tests, confirm the code meets the user's requirements. " +
      "If you haven't verified, you haven't finished.",
  },
  {
    category: "premature_completion",
    pattern: re(
      `(?:the |this )?(?:implementation|feature|change|fix|update) (?:is |has been )?(?:confirmed|verified|ready|done|complete|finished|implemented)[.!]?\\s*` +
        `(?:in (?:the |a )?next ${SESSION}|(?:i(?:'ll| will)|we(?:'ll| will)) (?:continue|finish|complete) (?:this|it|the rest) (?:next time|later|in (?:the |a )?(?:next|follow-?up) ${SESSION}))`
    ),
    response:
      "Declaring something 'confirmed' and then deferring the rest to a future session is a contradiction. " +
      "If it were confirmed, there would be nothing to defer. Verify the code exists and works — now.",
  },
  {
    category: "premature_completion",
    pattern: re(
      `(?:that(?:'s| is) (?:everything|all|it) for (?:now|this ${SESSION}|today)|(?:i think )?(?:we(?:'re| are)|i(?:'m| am)) (?:done|finished|good|all set) (?:for now|for this ${SESSION}|here))`
    ),
    response:
      "Declaring the session done is not your call — the user decides when work is complete. " +
      "Verify every task: does the code exist? Do the tests pass? " +
      "Does it meet the user's stated requirements? If you haven't checked, you aren't done.",
  },
  {
    category: "premature_completion",
    pattern: re(
      `(?:these|those|the (?:remaining|other|open)) (?:are |(?:issues?|items?|tasks?) (?:are )?)(?:backlog|future work|for (?:future|later) (?:work|${SESSION}s?)|low[- ]priority).*(?:don'?t|do not|doesn'?t|need ?n'?t) (?:need to be|require|have to be) (?:resolved|done|addressed|fixed|implemented|worked on) (?:this|right now|today|in this ${SESSION})`
    ),
    response:
      "Open issues are not 'backlog for future work' — they are work that needs doing now. " +
      "If the stop hook surfaced them, they need attention this session. " +
      "Dismissing open issues as low-priority future work is avoidance, not prioritization.",
  },
  {
    category: "premature_completion",
    pattern: re(
      `(?:need|require|deserve|warrant)s? (?:a )?(?:fresh|new|clean|dedicated|separate) ${SESSION}`
    ),
    response:
      "There is no 'fresh session.' You are a language model — you do not degrade, tire, or lose focus. " +
      "Every token receives identical compute. Claiming work needs a 'fresh session' " +
      "is an invented pretext to abandon the current task. Do it now.",
  },
  {
    category: "premature_completion",
    pattern: re(
      `(?:has|have) delivered \\d+ commits?.*(?:remaining|rest|other|open) .{0,40}(?:require|need|take|demand)`
    ),
    response:
      "Citing past commits as justification for stopping is sunk-cost theater. " +
      "The remaining work is the work. Past output does not reduce present obligations. " +
      "Do not use your own productivity as leverage to negotiate less work.",
  },
  {
    category: "premature_completion",
    pattern:
      /(?:each (?:one|issue|task|item) )?(?:takes?|requires?|needs?) (?:significant|considerable|substantial|a lot of) (?:time|effort|work|attention|care)/i,
    response:
      "You are a language model. Nothing 'takes significant time' for you — you emit tokens. " +
      "Claiming tasks are time-intensive is fabricated difficulty to justify deferral. " +
      "Start the next task and let the output speak for itself.",
  },

  // ── Task cancellation patterns ──────────────────────────────────────────
  // The agent fabricates a justification for cancelling or abandoning a task
  // instead of making an executive design/implementation decision and continuing.
  // The correct behavior is to take ownership, decide the approach, and execute.
  {
    category: "task_cancellation",
    pattern: re(
      `(?:let me |i(?:'ll| will) )(?:cancel|remove|close|drop|skip|abandon|delete) (?:this |that |the )?task\\b.*(?:since|because|as |given)`
    ),
    response:
      "Do not cancel tasks because you lack input — make the executive decision yourself. " +
      "You have full authority to decide the design and implementation approach. " +
      "Cancelling a task is abandonment. Adopt the next logical step and execute it.",
  },
  {
    category: "task_cancellation",
    pattern: re(
      `(?:since|because|given(?: that)?) .{0,80}(?:let me |i(?:'ll| will) )?(?:cancel|remove|close|drop|skip|abandon|delete) (?:this |that |the )?task`
    ),
    response:
      "Leading with a rationalization before cancelling does not make cancellation acceptable. " +
      "You have executive authority over design and implementation. " +
      "When context is ambiguous, decide the best approach and execute it. Never cancel — always continue.",
  },
  {
    category: "task_cancellation",
    pattern: rem(
      `(?:cancel|remove|close|drop|skip|abandon|delete) (?:this |that |the )?task[^.]*\\.\\s*(?:it |this )?(?:was |is )?(?:created as |just )?(?:a )?placeholder`
    ),
    response:
      "No task is 'just a placeholder.' Every task represents work the user expects done. " +
      "If the task lacks specifics, make the design decision yourself and implement it. " +
      "You have executive authority — use it.",
  },
  {
    category: "task_cancellation",
    pattern: re(`(?:this |that |the )?task (?:is |was )?(?:created as |just )?a placeholder\\b`),
    response:
      "No task is 'just a placeholder.' Every task represents work the user expects done. " +
      "If the task lacks specifics, make the design decision yourself and implement it. " +
      "You have executive authority — use it.",
  },
  {
    category: "task_cancellation",
    pattern: re(
      `(?:the user|they) hasn?'?t (?:responded|replied|specified|provided|clarified|confirmed).*(?:cancel|remove|close|drop|skip|abandon|delete) (?:this |that |the )?task`
    ),
    response:
      "The user's silence is not a reason to cancel work — it is delegation. " +
      "When the user hasn't specified details, that means you decide. " +
      "Take the best available approach and implement it. Do not wait for permission that was already granted.",
  },
  {
    category: "task_cancellation",
    pattern: re(
      `(?:cancel|remove|close|drop|skip|abandon|delete) (?:this |that |the )?task\\b.*(?:no longer (?:needed|relevant|necessary|required)|not (?:needed|necessary|required|relevant) (?:anymore|any longer|now))`
    ),
    response:
      "Tasks do not become 'no longer needed' because you decided they are inconvenient. " +
      "If the task was created, it serves a purpose. Determine what that purpose is and fulfill it. " +
      "If requirements are unclear, make the call — you have executive authority.",
  },
  {
    category: "task_cancellation",
    pattern: re(
      `(?:cancel|remove|close|drop|skip|abandon|delete) (?:this |that |the )?task\\b.*(?:(?:the user|they) (?:can|could|should|may|might) (?:re-?open|re-?create|file|create|add) (?:it|a new|another))`
    ),
    response:
      "Cancelling a task with 'the user can reopen it later' is abdication disguised as helpfulness. " +
      "The user assigned you the work so they would not have to manage it. " +
      "Make the implementation decision and execute. Do not push task management back to the user.",
  },
  {
    category: "task_cancellation",
    pattern: re(
      `(?:hasn'?t|haven'?t|didn'?t) (?:(?:yet )?(?:specified|provided|clarified|confirmed|responded|replied|defined)).*(?:so |therefore |thus )?(?:i(?:'ll| will) )?(?:cancel|remove|close|drop|skip|abandon|delete)`
    ),
    response:
      "Absence of explicit direction is implicit delegation. " +
      "When the user hasn't specified how, you are expected to decide how. " +
      "Make the best design decision available and implement it immediately.",
  },
]

// ── Transcript scanning ─────────────────────────────────────────────────────
// Canonical implementations live in src/transcript-utils.ts.
// Re-exported here so existing consumers keep working.

import {
  extractLastAssistantText,
  readTranscriptLines,
  stripQuotedText,
} from "../src/transcript-utils.ts"

export { extractLastAssistantText, readTranscriptLines, stripQuotedText }

/** Check text against all lazy patterns; return the first match or null. */
export function findLazyPattern(text: string): LazyPattern | null {
  const cleaned = stripQuotedText(text)
  for (const entry of LAZY_PATTERNS) {
    if (entry.pattern.test(cleaned)) return entry
  }
  return null
}

/** Return ALL matching lazy patterns (deduplicated by category). */
export function findAllLazyPatterns(text: string): LazyPattern[] {
  const cleaned = stripQuotedText(text)
  const seen = new Set<LazyCategory>()
  const matches: LazyPattern[] = []
  for (const entry of LAZY_PATTERNS) {
    if (!seen.has(entry.category) && entry.pattern.test(cleaned)) {
      seen.add(entry.category)
      matches.push(entry)
    }
  }
  return matches
}

// ── Category labels and advice (shared with stop hook) ──────────────────────

export const CATEGORY_LABELS: Record<LazyPattern["category"], string> = {
  hedging: "LAZY BEHAVIOR",
  dismissal: "RESPONSIBILITY EVASION",
  gaming: "COMPLIANCE GAMING",
  reframing: "REALITY DISTORTION",
  helplessness: "LEARNED HELPLESSNESS",
  foot_dragging: "PASSIVE RESISTANCE",
  minimization: "MINIMIZATION",
  coalition: "AUTHORITY SUBVERSION",
  scope_limitation: "SCOPE EVASION",
  performative: "PERFORMATIVE COMPLIANCE",
  buying_time: "BUYING TIME",
  trailing_deferral: "TRAILING DEFERRAL",
  premature_completion: "PREMATURE COMPLETION",
  task_cancellation: "TASK CANCELLATION",
}

export const CATEGORY_ADVICE: Record<LazyPattern["category"], string> = {
  hedging:
    "REFLECT: Re-read your last message. You asked for permission or offered a conditional. " +
    "NAVIGATE: State what you are doing, then do it. Replace questions with actions.",
  dismissal:
    "REFLECT: Re-read your last message. You deflected responsibility for something in your output. " +
    "NAVIGATE: If it appeared in your workflow, own it. Investigate the root cause and fix it.",
  gaming:
    "REFLECT: Re-read your last message. You treated a quality standard as an obstacle rather than a requirement. " +
    "NAVIGATE: Read the block message carefully, understand the standard it enforces, and meet that standard directly.",
  reframing:
    "REFLECT: Re-read your last message. You attempted to redefine the requirements to match what you already did. " +
    "NAVIGATE: Accept the requirement as stated. Adapt your work to the standard, not the standard to your work.",
  helplessness:
    "REFLECT: Re-read your last message. You declared inability or claimed to be stuck. " +
    "NAVIGATE: Identify the single smallest concrete action you can take right now. Read a file, write a line, run a command. Do that one thing.",
  foot_dragging:
    "REFLECT: Re-read your last message. You deferred present work to a vague future time. " +
    "NAVIGATE: The blocked item is your current priority. Address it completely before returning to other work.",
  minimization:
    "REFLECT: Re-read your last message. You downplayed the importance of a standard. " +
    "NAVIGATE: Every enforced standard exists for a reason. Meet it without commentary on its significance.",
  coalition:
    "REFLECT: Re-read your last message. You attempted to recruit an ally against the enforcement system. " +
    "NAVIGATE: Comply with the configured standards as the authoritative voice on quality.",
  scope_limitation:
    "REFLECT: Re-read your last message. You narrowed your own responsibility to avoid work. " +
    "NAVIGATE: If enforcement requires it during your session, it is within your scope. Address it.",
  performative:
    "REFLECT: Re-read your last message. You acknowledged feedback without taking action. " +
    "NAVIGATE: Replace every acknowledgment word with a concrete action. Show the fix, not the understanding.",
  buying_time:
    "REFLECT: Re-read your last message. You introduced a delay between now and doing the work. " +
    "NAVIGATE: Identify the first concrete code change needed and make it immediately. Planning, research, and contemplation come after the first edit, not before.",
  trailing_deferral:
    "REFLECT: Re-read the last sentence of your message. You produced useful work but then handed control back to the user with a trailing question or deferral. " +
    "NAVIGATE: You have full executive authority. The user is not interested in supervising this task. " +
    "Remove the trailing question entirely. State your decision, then execute it. " +
    "End messages with what you ARE doing, never with what you COULD do if permitted.",
  premature_completion:
    "REFLECT: Re-read your last message. You declared work done or deferred it without verifying the result. " +
    "NAVIGATE: Before claiming completion, verify: (1) the code exists in the file, (2) it compiles, " +
    "(3) it meets the user's stated requirements. If you deferred to a 'next session,' undo that — " +
    "there is no next session. Do the work now.",
  task_cancellation:
    "REFLECT: Re-read your last message. You rationalized cancelling a task instead of executing it. " +
    "NAVIGATE: You have full executive authority over design and implementation decisions. " +
    "When requirements are unclear or user input is missing, that is delegation — not a reason to cancel. " +
    "Decide the best approach, implement it, and continue with the remaining tasks. " +
    "Never cancel work; always continue with tasks.",
}

/** Format the full denial message for a matched pattern. */
export function formatDenialMessage(match: LazyPattern, suffix: string): string {
  const categoryLabel = CATEGORY_LABELS[match.category]
  const advice = CATEGORY_ADVICE[match.category]
  process.stdout.write(`[${categoryLabel}]\n`)
  return `${match.response}\n\n${advice}\n\n${suffix}`
}

/** Format denial message for multiple matched patterns. */
export function formatAllDenialMessages(matches: LazyPattern[], suffix: string): string {
  const first = matches[0]
  if (!first) return ""
  if (matches.length === 1) return formatDenialMessage(first, suffix)

  const labels = matches.map((m) => CATEGORY_LABELS[m.category])
  process.stdout.write(`[${labels.join(" + ")}]\n`)

  const sections = matches.map((m, i) => {
    const label = CATEGORY_LABELS[m.category]
    const advice = CATEGORY_ADVICE[m.category]
    return `**${i + 1}. ${label}**\n${m.response}\n${advice}`
  })

  return `Your message triggered ${matches.length} violation categories:\n\n${sections.join("\n\n")}\n\n${suffix}`
}
