// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref } from 'vue'
import { feedbackKey, routerKey, sessionKey } from '@antarestra/webui/client'
import HistoryPage from '../../plugins/features/im-console/client/HistoryPage.vue'

const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  vi.unstubAllGlobals()
})
async function mount() {
  const currentRoute = ref({ query: {} as Record<string, string> })
  const router = {
    currentRoute,
    async push(value: { query: Record<string, string> }) {
      currentRoute.value = value
    },
    async replace(value: { query: Record<string, string> }) {
      currentRoute.value = value
    },
  }
  const modal = vi.fn().mockResolvedValue(true)
  const toast = vi.fn()
  const row = {
    workspaceId: 'group',
    name: '测试群',
    chatId: '123',
    connectionId: 'qq',
    platform: 'qq',
    connected: false,
    archived: false,
    lastMessageAt: null,
  }
  let deleted = false
  let failure = false
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method) {
      if (failure) return Response.json({ error: '模拟请求失败' }, { status: 503 })
      if (options.method === 'DELETE') deleted = true
      else row.archived = JSON.parse(String(options.body)).archived
      return Response.json({ ok: true })
    }
    if (url.includes('/messages?')) return Response.json({ messages: [], nextBefore: null })
    const visible = !deleted && row.archived === url.includes('archived=true')
    return Response.json({ groups: visible ? [{ ...row }] : [], total: visible ? 1 : 0 })
  })
  vi.stubGlobal('fetch', fetcher)
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(HistoryPage)
  app.provide(routerKey, router as never)
  app.provide(sessionKey, {
    snapshot: ref({ permissions: ['admin.im.history.manage', 'admin.im.bot.manage'] }),
  } as never)
  app.provide(feedbackKey, { modal, toast, notice: toast, messagebox: modal })
  app.mount(host)
  disposers.push(() => {
    app.unmount()
    host.remove()
  })
  await expect.poll(() => host.textContent).toContain('测试群')
  const click = async (text: string) => {
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!
    expect(button).toBeDefined()
    button.click()
    await nextTick()
  }
  return {
    host,
    router,
    modal,
    toast,
    fetcher,
    click,
    fail: () => {
      failure = true
    },
  }
}
it('归档先确认，归档列表可查看记录、恢复和删除，永久删除确认后清除列表', async () => {
  const page = await mount()
  expect(page.host.textContent).toContain('已停止接入')
  page.modal.mockResolvedValueOnce(false)
  await page.click('归档')
  expect(page.fetcher.mock.calls.filter(([, options]) => options?.method)).toHaveLength(0)
  await page.click('归档')
  await expect.poll(() => page.host.textContent).toContain('暂无群聊记录')
  await page.click('已归档群聊')
  await expect.poll(() => page.host.textContent).toContain('取消归档')
  expect(page.router.currentRoute.value.query.archived).toBe('true')
  expect(page.host.textContent).not.toContain('bot 管理员')
  expect(page.host.textContent).toContain('查看记录')
  await page.click('查看记录')
  expect(page.router.currentRoute.value.query).toMatchObject({ archived: 'true', group: 'group' })
  await expect
    .poll(() =>
      page.fetcher.mock.calls.some(([url]) => url.startsWith('/api/im/groups/group/messages?')),
    )
    .toBe(true)
  await page.click('返回群列表')
  expect(page.router.currentRoute.value.query.archived).toBe('true')
  expect(page.router.currentRoute.value.query.group).toBeUndefined()
  expect(page.host.textContent).toContain('取消归档')
  await page.click('永久删除')
  await expect.poll(() => page.host.textContent).toContain('暂无已归档群聊')
  expect(page.modal).toHaveBeenLastCalledWith(
    expect.stringContaining('永久删除'),
    expect.stringContaining('AI 会话历史'),
    { confirmLabel: '永久删除', danger: true },
  )
})
it('取消归档无需确认，操作失败保留记录并显示错误', async () => {
  const page = await mount()
  await page.click('归档')
  await expect.poll(() => page.host.textContent).toContain('暂无群聊记录')
  await page.click('已归档群聊')
  await expect.poll(() => page.host.textContent).toContain('取消归档')
  await page.click('取消归档')
  await expect.poll(() => page.host.textContent).toContain('暂无已归档群聊')
  expect(page.modal).toHaveBeenCalledTimes(1)
  await page.click('返回群列表')
  await expect.poll(() => page.host.textContent).toContain('测试群')
  page.fail()
  await page.click('归档')
  await expect.poll(() => page.host.textContent).toContain('模拟请求失败')
  expect(page.host.textContent).toContain('测试群')
})
