export type ReqStatus =
  | 'captured'
  | 'in_progress'
  | 'implemented'
  | 'verified'
  | 'blocked'
  | 'needs_clarification'
  | 'revisit'
  | 'deferred'

export type Evidence = {
  kind: 'test' | 'edit' | 'manual' | 'note'
  at: number
  text: string
  eventId?: string
}

export type ReqVersion = {
  at: number
  text: string
  kind: 'original' | 'refinement'
  by: 'you' | 'agent'
}

export type Requirement = {
  id: string
  title: string
  status: ReqStatus
  at: number
  history: ReqVersion[]
  evidence: Evidence[]
  needsReverify?: boolean
  // Set when a later message or the agent's work contradicts this requirement.
  conflict?: { reason: string; at: number; source: 'you' | 'agent' }
  // Done for now: when or why to come back to it, in your words (status 'revisit').
  revisit?: string
  // When the agent was last asked to verify this (status 'implemented'); cleared when it leaves that status.
  nudgedAt?: number
  // Nothing can be run to verify this: what a person should check instead (status 'implemented').
  manual?: string
}

// Things worth acting on that are easy to miss in the chat: a tool call that failed or was
// refused, something the agent found that was new or unexpected, or a conflicting instruction.
export type SignalKind = 'failed' | 'blocked' | 'finding' | 'conflict'
export type Signal = {
  id: string
  kind: SignalKind
  at: number
  text: string
  eventId?: string
  reqId?: string
  dismissed?: boolean
  // What was going on when it happened: your message that started the turn, what the agent
  // ran or touched, and the first of what came back.
  context?: { ask?: string; did?: string; output?: string }
}

export type PlanStep = {
  text: string
  status: 'pending' | 'in_progress' | 'completed'
  reqIds: string[]
}

export type Preview = { url: string; at: number; eventId: string }

// What the session costs this computer (the same shape as hooks/footprint.ts): memory its
// processes hold now, and the files it leaves, in KB.
export type Footprint = {
  at: number
  pid?: number
  procs: number
  ramKb: number
  transcriptKb: number
  ledgerKb: number
  workspaceKb: number
  workspace?: { path: string; kind: 'scratch' | 'worktree' }
  editedKb?: number
  editedFiles?: number
  scratchKb?: number
  scratch?: string
  fetchedKb?: number
  fetched?: { path: string; kb: number }[]
  sharedKb?: number
  sharedDataKb?: number
  shared?: { path: string; kb: number; role?: 'deps' | 'data' }[]
  cacheKb?: number
  caches?: { path: string; kb: number }[]
}

export type EventKind = 'discovery' | 'plan' | 'code' | 'command' | 'test' | 'message'

export type ActivityEvent = {
  id: string
  kind: EventKind
  at: number
  title: string
  detail?: string
  file?: string
  diff?: string
  state?: 'running' | 'ok' | 'failed'
  // The requirements the turn it happened in worked on.
  reqIds?: string[]
}

export type ReplyMode = 'comment' | 'requirement' | 'redirect'
export type Delivery = 'kept' | 'queued' | 'received' | 'acted' | 'failed'

export type Reply = {
  id: string
  eventId: string
  at: number
  text: string
  mode: ReplyMode
  delivery: Delivery
  reqId?: string
  interrupt?: boolean
  error?: string
}

export type Filter = 'key' | 'all' | 'code' | 'tests' | 'messages'
export type ReqFilter = 'all' | 'open' | 'unverified' | 'verified' | 'conflicts' | 'yours' | 'agents'

export type View = {
  tab: 'reqs' | 'signals' | 'activity' | 'plan' | 'tests' | 'preview' | 'audit'
  selectedEvent?: string
  selectedReq?: string
  mode: ReplyMode
  refines: string
  interrupt: boolean
  filter: Filter
  dark: boolean
  search?: string
  reqFilter?: ReqFilter
}

export type ThemeTokens = {
  bg: string
  surface: string
  surface2: string
  border: string
  text: string
  text2: string
  text3: string
  done: string
  active: string
  warn: string
  danger: string
}

export type Theme = {
  name: string
  dark: ThemeTokens
  light: ThemeTokens
}

declare module 'claude-code' {
  interface PluginState {
    principia: {
      reqs: Requirement[]
      events: ActivityEvent[]
      replies: Reply[]
      view: View
      turnId: string
      inboxSeq: number
      title: string
      theme: Theme
      signals: Signal[]
      plan: PlanStep[]
      drawn: boolean
      turns: { at: number; ask: string; answer: string }[]
      previews: Preview[]
      footprint?: Footprint
    }
  }
}
