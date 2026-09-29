import type { ClientPlugin } from '@antarestra/webui/client'
import { uploadSlot } from '@antarestra/storage/client'
import { upload } from './upload.js'
const apply: ClientPlugin = (ctx) => {
  ctx.contribute(uploadSlot, 's3', upload)
}
export default apply
