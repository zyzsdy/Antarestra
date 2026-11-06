import { Server } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { fileURLToPath } from 'node:url'
import type { JsonObject } from '@antarestra/contracts'

export function createMcpServer(
  label = '测试',
  options: {
    paginated?: boolean
    delay?: boolean
    image?: boolean
    inputSchema?: JsonObject & { type: 'object' }
  } = {},
) {
  const server = new Server(
    { name: 'antarestra-test-mcp', version: '1.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  )
  let names = ['get_files']
  const entered = Promise.withResolvers<void>()
  const cancelled = Promise.withResolvers<void>()
  server.setRequestHandler('tools/list', async (request) => {
    const list = request.params?.cursor === 'next' ? ['second_tool'] : names
    return {
      tools: list.map((name) => ({
        name,
        description: label,
        inputSchema: options.inputSchema ?? {
          type: 'object' as const,
          properties: { fail: { type: 'boolean' } },
        },
      })),
      ...(options.paginated && !request.params?.cursor ? { nextCursor: 'next' } : {}),
    }
  })
  server.setRequestHandler('tools/call', async (request, context) => {
    entered.resolve()
    if (options.delay)
      await new Promise<void>((resolve) =>
        context.mcpReq.signal.addEventListener(
          'abort',
          () => {
            cancelled.resolve()
            resolve()
          },
          { once: true },
        ),
      )
    return {
      content: [
        { type: 'text' as const, text: `${label}:${request.params.name}` },
        ...(options.image
          ? [
              {
                type: 'image' as const,
                mimeType: 'image/png',
                data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1X8AAAAASUVORK5CYII=',
              },
            ]
          : []),
      ],
      structuredContent: {
        cwd: process.cwd(),
        env: process.env.MCP_TEST_VALUE ?? '',
        pid: process.pid,
        args: process.argv.slice(2),
      },
      isError: request.params.arguments?.fail === true,
    }
  })
  return {
    server,
    entered: entered.promise,
    cancelled: cancelled.promise,
    change: async (value: string[]) => {
      names = value
      await server.sendToolListChanged()
    },
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server } = createMcpServer('本地')
  await server.connect(new StdioServerTransport())
}
