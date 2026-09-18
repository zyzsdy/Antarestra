// 使用相同真实文件监视场景验证配置管理服务与官方 HMR 的生命周期协调。
process.env.ANTARESTRA_TEST_MANAGED_HMR = '1'
await import('./hmr-runner.mjs')
