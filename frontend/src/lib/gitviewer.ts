export function defaultGitTab(dirty: number): 'worktree' | 'history' {
  return dirty > 0 ? 'worktree' : 'history'
}
// Fixed prompts forwarded into the session's agent chat from the worktree panel.
export const COMMIT_PROMPT = '把当前工作区的未提交改动提交,commit message 自行总结本次改动。'
export const DISCARD_PROMPT = '撤销(git restore)当前工作区的全部未提交改动,不要提交。'
