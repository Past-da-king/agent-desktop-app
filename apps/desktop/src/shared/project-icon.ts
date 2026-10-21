/**
 * A project's own picture (a website's logo, say), stored on the project as a small data URL: square, at most
 * 128 pixels, PNG, JPEG or WebP, so it syncs with the project and draws anywhere without a file on disk.
 */
export const ICON_IMAGE_PX = 128
/** About 90 KB of base64: a 128 px picture is far smaller; anything bigger is refused rather than synced. */
export const ICON_IMAGE_MAX = 120_000

export function isIconImage(value: unknown): value is string {
  return typeof value === 'string' && value.length <= ICON_IMAGE_MAX && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
}
