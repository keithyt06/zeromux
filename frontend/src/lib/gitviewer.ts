export function defaultGitTab(dirty: number): 'worktree' | 'history' {
  return dirty > 0 ? 'worktree' : 'history'
}
// Prompts forwarded to an agent from the worktree panel. They name the absolute
// work dir so an agent can never act on its own repo by mistake (A2).
export const commitPrompt = (workDir: string) =>
  `在 ${workDir} 下,把该工作区的未提交改动提交,commit message 自行总结本次改动。`
export const discardPrompt = (workDir: string) =>
  `在 ${workDir} 下,撤销(git restore)该工作区的全部未提交改动,不要提交。`
