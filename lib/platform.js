// Same result as Node's `path.extname(fileName).slice(1)` for asset names,
// without depending on Node.js APIs.
const extname = fileName => {
  const index = fileName.lastIndexOf('.')
  return index > 0 ? fileName.slice(index + 1) : ''
}

export default fileName => {
  const extension = extname(fileName)
  const arch =
    fileName.includes('arm64') || fileName.includes('aarch64') ? '_arm64' : ''

  if (
    (fileName.includes('mac') || fileName.includes('darwin')) &&
    extension === 'zip'
  ) {
    return 'darwin' + arch
  }

  const directCache = ['exe', 'dmg', 'rpm', 'deb', 'AppImage']
  return directCache.includes(extension) ? extension + arch : false
}
