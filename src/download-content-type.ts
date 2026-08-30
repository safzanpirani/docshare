export const APK_CONTENT_TYPE = 'application/vnd.android.package-archive'

export function contentTypeForDownload(filename: string, storedContentType: string): string {
  const basename = filename.toLowerCase().split(/[\\/]/).pop() ?? ''
  return basename.endsWith('.apk') ? APK_CONTENT_TYPE : storedContentType
}
