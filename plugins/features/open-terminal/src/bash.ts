import { shellQuote } from './edit.js'

export const bashOutputNotice = (path: string) =>
  `因输出太长已截断。只保留前100行和后100行，若需读取完整内容，请使用 \`read\` 读取 ${path}`

export function bashOutputPath(id: string) {
  return `/tmp/antarestra-bash-${id}.log`
}

// 完整输出直接写入远端文件，不依赖 Open Terminal 可轮转的进程日志。
// 流式逐行扫描，只保留两端；限制单行缓存，防止极长行占用无限内存。
const script = `import base64, collections, json, subprocess, sys
args = json.loads(base64.b64decode(sys.argv[1]))
with open(args['path'], 'xb') as output:
    code = subprocess.call(['bash', '-c', args['command']], stdout=output, stderr=subprocess.STDOUT)
head, tail = [], collections.deque(maxlen=100)
count = 0
long_line = False
last_newline = False
with open(args['path'], 'rb') as output:
    while True:
        part = output.readline(65536)
        if not part:
            break
        line = part
        while not part.endswith(b'\\n'):
            part = output.readline(65536)
            if not part:
                break
            long_line = True
        last_newline = part.endswith(b'\\n')
        line = line.rstrip(b'\\r\\n')
        count += 1
        if count <= 200:
            head.append(line)
        tail.append(line)
lines = head[:100] + list(tail) if count > 200 else head
lines = [line.decode('utf-8', errors='replace').encode() for line in lines]
budget = 48 * 1024 - len(lines)
clipped = long_line or sum(map(len, lines)) > budget
if clipped and lines:
    low, high = 0, 65536
    while low < high:
        mid = (low + high + 1) // 2
        if sum(min(len(line), mid) for line in lines) <= budget:
            low = mid
        else:
            high = mid - 1
    suffix = '…[本行截断]'.encode()
    lines = [line if len(line) <= low else line[:max(0, low-len(suffix))].decode('utf-8', errors='ignore').encode() + suffix for line in lines]
decoded = [line.decode('utf-8', errors='replace') for line in lines]
if count > 200:
    decoded.insert(100, args['notice'])
if clipped:
    decoded.append('[超长行另按 48 KiB 总预算截断；请使用 read 读取 ' + args['path'] + ']')
rendered = '\\n'.join(decoded) + ('\\n' if last_newline else '')
# 避免远端 PTY 按字节块解码时切断 UTF-8 字符，传输时仅输出 ASCII JSON。
print(json.dumps({'output': rendered, 'truncated': count > 200 or clipped}, ensure_ascii=True))
sys.exit(code if code >= 0 else 128 - code)
`

export function bashCommand(command: string, path: string) {
  const payload = Buffer.from(
    JSON.stringify({
      command,
      path,
      notice: bashOutputNotice(path),
    }),
  ).toString('base64')
  return `python3 -c ${shellQuote(script)} ${shellQuote(payload)}`
}
