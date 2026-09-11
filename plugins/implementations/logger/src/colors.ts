type RGB = readonly [number, number, number]

function hsl(hue: number, saturation: number, lightness: number): RGB {
  const a = saturation * Math.min(lightness, 1 - lightness)
  const channel = (offset: number) => {
    const k = (offset + hue / 30) % 12
    return Math.round(255 * (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return [channel(0), channel(8), channel(4)]
}

// 先使用柔和的低饱和度颜色；色相交错，避免相邻插件过于相似。
export const trueColors: readonly RGB[] = Object.freeze(
  [0.3, 0.4, 0.5].flatMap((saturation) =>
    [0.56, 0.64].flatMap((lightness) =>
      Array.from({ length: 36 }, (_, index) =>
        Object.freeze(hsl(((index * 13) % 36) * 10, saturation, lightness)),
      ),
    ),
  ),
)

function extendedRgb(index: number): RGB {
  if (index >= 232) {
    const gray = 8 + (index - 232) * 10
    return [gray, gray, gray]
  }
  const cube = index - 16
  const channel = (n: number) => (n === 0 ? 0 : 55 + n * 40)
  return [channel(Math.floor(cube / 36)), channel(Math.floor(cube / 6) % 6), channel(cube % 6)]
}

function softness(index: number): number {
  const rgb = extendedRgb(index)
  const max = Math.max(...rgb)
  const min = Math.min(...rgb)
  const lightness = (max + min) / 510
  // 优先中等明度、低饱和度，少量惩罚完全无彩色，保留插件辨识度。
  return Math.abs(lightness - 0.57) * 3 + (max - min) / 255 + (max === min ? 0.35 : 0)
}

export const indexedColors: readonly number[] = Object.freeze(
  Array.from({ length: 240 }, (_, index) => index + 16)
    .sort((a, b) => softness(a) - softness(b) || a - b)
    .slice(0, 216),
)

export interface ColorStream {
  isTTY?: boolean
  getColorDepth?: (env?: NodeJS.ProcessEnv) => number
}

export function colorDepth(stream: ColorStream, env = process.env): number {
  if (!stream.isTTY || env.NO_COLOR !== undefined) return 1
  return stream.getColorDepth?.(env) ?? 1
}

export function createColorizer(depth: number): (name: string) => string {
  const names = new Map<string, number>()
  const basic = [36, 32, 33, 34, 35, 31, 96, 92, 93, 94, 95, 91]
  return (name) => {
    const label = `[${name}]`
    if (depth < 4) return label
    let index = names.get(name)
    if (index === undefined) {
      index = names.size
      names.set(name, index)
    }
    const code =
      depth >= 24
        ? `38;2;${trueColors[index % trueColors.length]!.join(';')}`
        : depth >= 8
          ? `38;5;${indexedColors[index % indexedColors.length]}`
          : `${basic[index % basic.length]}`
    return `\x1b[${code}m${label}\x1b[0m`
  }
}
