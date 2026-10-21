import { ICON_IMAGE_MAX, ICON_IMAGE_PX, isIconImage } from '../../shared/project-icon'

/**
 * A picture the person picked, made into a project icon: cut square from the middle, scaled to 128 px, as a PNG
 * data URL (WebP when that is smaller). Throws with a plain message when the file is not a picture.
 */
export async function iconFromFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('That file is not a picture.')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('That picture could not be read. Try a PNG or JPG.')
  }
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = ICON_IMAGE_PX
  canvas.height = ICON_IMAGE_PX
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('That picture could not be read.')
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, ICON_IMAGE_PX, ICON_IMAGE_PX)
  bitmap.close()
  const png = canvas.toDataURL('image/png')
  const webp = canvas.toDataURL('image/webp', 0.9)
  const best = webp.startsWith('data:image/webp') && webp.length < png.length ? webp : png
  if (!isIconImage(best) || best.length > ICON_IMAGE_MAX) throw new Error('That picture is too detailed to use as an icon.')
  return best
}
