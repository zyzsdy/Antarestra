import { afterEach, expect, it, vi } from 'vitest'
import type { RunContext } from '@antarestra/ai'
import imAi from '@antarestra/plugin-im-ai'
import { cleanup, setup } from './im-features-fixture.js'

afterEach(cleanup)

it('撤回工具拒绝伪造运行上下文，并随 IM AI 插件卸载和重载注册', async () => {
  const app = await setup({ ai: true, toolIds: ['im_recall_message'] })
  expect(JSON.stringify(app.ctx.ai.capabilities())).toContain('im_recall_message')
  await app.aiPlugin!.dispose()
  expect(JSON.stringify(app.ctx.ai.capabilities())).not.toContain('im_recall_message')
  const registered = vi.spyOn(app.ctx.ai, 'registerTool')
  await app.ctx.plugin(imAi, { pollIntervalMs: 20 })
  const tool = registered.mock.calls.find(([, tool]) => tool.id === 'im_recall_message')![1]
  const invoke = vi.spyOn(app.ctx.im, 'invoke')
  await expect(
    tool.execute({ message_id: '1' }, { runId: 'fake' } as RunContext),
  ).resolves.toMatchObject({
    isError: true,
    content: { code: 'forbidden' },
  })
  expect(invoke).not.toHaveBeenCalled()
})
