import { inject, onUnmounted, ref } from 'vue'
import { sessionKey, routerKey } from '@antarestra/webui/client'
export function useApi() {
  const session = inject(sessionKey)!
  const router = inject(routerKey)!
  const message = ref('')
  const busy = ref(false)
  const controller = new AbortController()
  onUnmounted(() => controller.abort())
  async function api<T>(path: string, body?: object, method = 'POST'): Promise<T> {
    const response = await fetch('/api' + path, {
      signal: controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(body
        ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    })
    const data = await response.json()
    if (response.status === 401) {
      const accountPath = session.read()?.accountPath ?? '/auth/user/'
      session.clear()
      if (!path.endsWith('/login') && path !== '/auth/me')
        void router.push({
          path: accountPath,
          query: { returnTo: router.currentRoute.value.fullPath },
        })
    }
    if (!response.ok) throw new Error(data.error || '请求失败')
    return data as T
  }
  async function run(action: () => Promise<void>) {
    if (busy.value) return
    busy.value = true
    message.value = ''
    try {
      await action()
    } catch (error) {
      if (!controller.signal.aborted)
        message.value = error instanceof Error ? error.message : '请求失败'
    } finally {
      busy.value = false
    }
  }
  return { api, run, message, busy, session, router }
}
