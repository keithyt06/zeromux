import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import PushSettings from '../PushSettings'
import { Toaster } from '../ui'
import * as pushLib from '../../lib/push'

// Mock push.ts
vi.mock('../../lib/push', () => ({
  getPushState: vi.fn().mockResolvedValue('disabled'),
  enablePush: vi.fn().mockResolvedValue(undefined),
  disablePush: vi.fn().mockResolvedValue(undefined),
  getLevels: vi.fn().mockReturnValue({ important: true, routine: false }),
  setLevels: vi.fn().mockResolvedValue(undefined),
  sendTestPush: vi.fn().mockResolvedValue(undefined),
}))

describe('PushSettings', () => {
  let origUA: string

  beforeEach(() => {
    origUA = navigator.userAgent
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', { value: origUA, configurable: true })
    vi.clearAllMocks()
  })

  it('渲染主开关按钮', async () => {
    render(<PushSettings open onClose={() => {}} />)
    // The toggle button or status label should be present
    expect(screen.getByRole('button', { name: /关闭|close/i })).toBeInTheDocument()
    // There should be some push-related text
    expect(screen.getByText(/通知|推送|push/i)).toBeInTheDocument()
  })

  it('iOS 未安装时显示引导说明', async () => {
    // Simulate iPhone UA
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      configurable: true,
    })
    // Ensure not standalone
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    })

    render(<PushSettings open onClose={() => {}} />)
    // Should show iOS hint with share/add steps
    expect(screen.getAllByText(/分享|主屏幕|Safari/i).length).toBeGreaterThan(0)
  })

  it('非 iOS 时不显示 iOS 引导', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/114',
      configurable: true,
    })

    render(<PushSettings open onClose={() => {}} />)
    expect(screen.queryByText(/Safari/i)).toBeNull()
  })

  it('shows test-push button when enabled and calls sendTestPush', async () => {
    const sendTestPushMock = vi.mocked(pushLib.sendTestPush)
    vi.mocked(pushLib.getPushState).mockResolvedValue('enabled')

    render(<PushSettings open onClose={() => {}} />)
    const btn = await screen.findByRole('button', { name: /测试推送/ })
    fireEvent.click(btn)
    expect(sendTestPushMock).toHaveBeenCalled()
  })

  it('toggle failure shows a toast and keeps the switch off', async () => {
    vi.mocked(pushLib.getPushState).mockResolvedValue('disabled')
    vi.mocked(pushLib.enablePush).mockRejectedValue(new Error('subscribe failed'))
    render(<><Toaster /><PushSettings open onClose={() => {}} /></>)
    const sw = await screen.findByRole('switch')
    await waitFor(() => expect(sw).not.toBeDisabled())
    fireEvent.click(sw)
    expect(await screen.findByText(/开启失败/)).toBeInTheDocument()
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })

  it('test-push failure shows a toast', async () => {
    vi.mocked(pushLib.getPushState).mockResolvedValue('enabled')
    vi.mocked(pushLib.sendTestPush).mockRejectedValueOnce(new Error('500'))
    render(<><Toaster /><PushSettings open onClose={() => {}} /></>)
    fireEvent.click(await screen.findByRole('button', { name: /测试推送/ }))
    expect(await screen.findByText('测试推送发送失败')).toBeInTheDocument()
  })
})
