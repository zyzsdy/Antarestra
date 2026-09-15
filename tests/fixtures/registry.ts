import { Service, ScopedRegistry } from '@antarestra/plugin-sdk'
import type { Context } from '@antarestra/plugin-sdk'

declare module '@antarestra/plugin-sdk' {
  interface Context {
    testRegistry: TestRegistry
  }
}

// 仅用于验证通用插件生命周期，不作为工作区插件发布或加载。
export class TestRegistry extends Service {
  readonly entries = new ScopedRegistry<string>()

  constructor(ctx: Context) {
    super(ctx, 'testRegistry')
  }
}

export const registration = {
  name: 'test-registration',
  inject: ['testRegistry'],
  apply(ctx: Context, config: { id: string; value: string }) {
    ctx.testRegistry.entries.register(ctx, config.id, config.value)
  },
}
