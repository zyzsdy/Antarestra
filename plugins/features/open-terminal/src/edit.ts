import type { JsonObject } from '@antarestra/ai'

export function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'"
}

// 数据只通过 Base64 JSON 传入，路径与替换内容不会插入 Python 或 Shell 源码。
// 所有匹配基于原文件；失败时不写入，保留 UTF-8 BOM 和原有 CRLF 换行。
const script = `import base64, difflib, json, os, sys
args = json.loads(base64.b64decode(sys.argv[1]))
path = os.path.expanduser(args['path'])
with open(path, 'r+b') as file:
    import fcntl
    fcntl.flock(file, fcntl.LOCK_EX)
    raw = file.read()
    bom = raw.startswith(b'\\xef\\xbb\\xbf')
    original = raw.decode('utf-8-sig')
    crlf = '\\r\\n' in original
    text = original.replace('\\r\\n', '\\n')
    matches = []
    for edit in args['edits']:
        old = edit['oldText'].replace('\\r\\n', '\\n')
        new = edit['newText'].replace('\\r\\n', '\\n')
        start = text.find(old)
        if not old or start < 0:
            raise ValueError('待替换文本为空或未找到，请重新读取文件')
        if text.find(old, start + 1) >= 0:
            raise ValueError('待替换文本存在多处匹配，请提供更多上下文')
        matches.append((start, start + len(old), new))
    matches.sort()
    if any(left[1] > right[0] for left, right in zip(matches, matches[1:])):
        raise ValueError('替换范围重叠，请合并相邻修改')
    updated = text
    for start, end, new in reversed(matches):
        updated = updated[:start] + new + updated[end:]
    if updated == text:
        raise ValueError('替换没有产生任何变化')
    result = updated.replace('\\n', '\\r\\n') if crlf else updated
    encoded = (b'\\xef\\xbb\\xbf' if bom else b'') + result.encode('utf-8')
    file.seek(0)
    file.write(encoded)
    file.truncate()
    diff = ''.join(difflib.unified_diff(text.splitlines(True), updated.splitlines(True), fromfile=args['path'], tofile=args['path']))
    lines = diff.splitlines(True)
    data = ''.join(lines[-2000:]).encode('utf-8')
    truncated = len(lines) > 2000 or len(data) > 50 * 1024
    output = '已编辑 ' + args['path'] + '\\n' + data[-50 * 1024:].decode('utf-8', errors='ignore')
    if truncated:
        output += '\\n[差异过长已截断，请使用 read 读取修改后的文件。]'
    print(json.dumps({'output': output, 'truncated': truncated}, ensure_ascii=True))
`

export function editCommand(args: JsonObject) {
  const edits = args.edits ?? [{ oldText: args.oldText, newText: args.newText }]
  const payload = Buffer.from(JSON.stringify({ path: args.path, edits })).toString('base64')
  return `python3 -c ${shellQuote(script)} ${shellQuote(payload)}`
}
