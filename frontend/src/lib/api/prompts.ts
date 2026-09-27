import { api } from './core'

// Prompt presets API (global, not session-scoped)
export interface PromptPreset {
  id: string
  title: string
  body: string
  created_at: string
  updated_at: string
  sort_order: number
}

export async function listPrompts(): Promise<PromptPreset[]> {
  const res = await api('/api/prompts')
  if (!res.ok) throw new Error('Failed to list prompts')
  const data = await res.json()
  return data.presets || []
}

export async function createPrompt(title: string, body: string): Promise<PromptPreset> {
  const res = await api('/api/prompts', {
    method: 'POST',
    body: JSON.stringify({ title, body }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function updatePrompt(
  id: string,
  fields: { title?: string; body?: string },
): Promise<void> {
  const res = await api(`/api/prompts/${id}`, {
    method: 'PUT',
    body: JSON.stringify(fields),
  })
  if (!res.ok) throw new Error(await res.text())
}

export async function deletePrompt(id: string): Promise<void> {
  const res = await api(`/api/prompts/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to delete prompt')
}
