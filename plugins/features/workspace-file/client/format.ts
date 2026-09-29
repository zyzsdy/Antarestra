export function bytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1024) return `${value} B`
  const unit = Math.min(3, Math.floor(Math.log(value) / Math.log(1024)))
  return `${(value / 1024 ** unit).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${['B', 'KiB', 'MiB', 'GiB'][unit]}`
}
