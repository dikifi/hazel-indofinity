// Packages
import semver from 'semver'
import useragent from 'express-useragent'
import distanceInWordsToNow from 'date-fns/distance_in_words_to_now/index.js'

// Utilities
import checkAlias from './aliases.js'
import render from './view.js'

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  })

const text = (status, body, headers = {}) =>
  new Response(body, {
    status,
    headers: Object.assign(
      { 'Content-Type': 'text/plain; charset=utf-8' },
      headers
    )
  })

const redirect = location =>
  new Response(null, { status: 302, headers: { Location: location } })

const noContent = () => new Response(null, { status: 204 })

// Tells clients when it makes sense to come back.
const unavailable = retryAfter =>
  text(
    503,
    'Downloads are temporarily unavailable, GitHub could not be reached',
    { 'Retry-After': String(retryAfter) }
  )

export default ({ config }) => {
  const exports = {}
  const { token } = config
  const shouldProxyPrivateDownload =
    token && typeof token === 'string' && token.length > 0

  // When GitHub is failing in private repo mode, download links cannot be
  // requested either, so no update is offered until GitHub works again:
  // "no update" (204) is the cheapest answer for the auto updater, and does
  // not make it start a download that would fail.
  const isBlocked = latest =>
    Boolean(latest.unavailable) && shouldProxyPrivateDownload

  // Helpers
  const proxyPrivateDownload = async (asset, getDownloadLink) => {
    const { location, retryAfter } = await getDownloadLink(asset)
    return location ? redirect(location) : unavailable(retryAfter)
  }

  const sendDownload = async (latest, platform, getDownloadLink) => {
    if (isBlocked(latest)) {
      return unavailable(latest.unavailable.retryAfter)
    }

    if (!latest.platforms || !latest.platforms[platform]) {
      return null
    }

    if (shouldProxyPrivateDownload) {
      return proxyPrivateDownload(latest.platforms[platform], getDownloadLink)
    }

    return redirect(latest.platforms[platform].url)
  }

  exports.download = async ({ request, url, loadCache, getDownloadLink }) => {
    const userAgent = useragent.parse(request.headers.get('user-agent') || '')
    const isUpdate = url.searchParams.get('update')

    let platform

    if (userAgent.isMac && isUpdate) {
      platform = 'darwin'
    } else if (userAgent.isMac && !isUpdate) {
      platform = 'dmg'
    } else if (userAgent.isWindows) {
      platform = 'exe'
    }

    // Get the latest version from the cache
    const latest = await loadCache()

    if (!latest.version && latest.unavailable) {
      return unavailable(latest.unavailable.retryAfter)
    }

    const response = platform
      ? await sendDownload(latest, platform, getDownloadLink)
      : null

    return response || text(404, 'No download available for your platform!')
  }

  exports.downloadPlatform = async ({
    url,
    params,
    loadCache,
    getDownloadLink
  }) => {
    const isUpdate = url.searchParams.get('update')

    let { platform } = params

    if (platform === 'mac' && !isUpdate) {
      platform = 'dmg'
    }

    if (platform === 'mac_arm64' && !isUpdate) {
      platform = 'dmg_arm64'
    }

    // Get the latest version from the cache
    const latest = await loadCache()

    // Check platform for appropiate aliases
    platform = checkAlias(platform)

    if (!platform) {
      return text(500, 'The specified platform is not valid')
    }

    if (!latest.version && latest.unavailable) {
      return unavailable(latest.unavailable.retryAfter)
    }

    const response = await sendDownload(latest, platform, getDownloadLink)
    return response || text(404, 'No download available for your platform')
  }

  exports.update = async ({ url, params, loadCache }) => {
    const { platform: platformName, version } = params

    if (!semver.valid(version)) {
      return json(500, {
        error: 'version_invalid',
        message: 'The specified version is not SemVer-compatible'
      })
    }

    const platform = checkAlias(platformName)

    if (!platform) {
      return json(500, {
        error: 'invalid_platform',
        message: 'The specified platform is not valid'
      })
    }

    // Get the latest version from the cache
    const latest = await loadCache()

    if (isBlocked(latest) || !latest.platforms || !latest.platforms[platform]) {
      return noContent()
    }

    // Previously, we were checking if the latest version is
    // greater than the one on the client. However, we
    // only need to compare if they're different (even if
    // lower) in order to trigger an update.

    // This allows developers to downgrade their users
    // to a lower version in the case that a major bug happens
    // that will take a long time to fix and release
    // a patch update.

    if (semver.compare(latest.version, version) !== 0) {
      const { notes, pub_date } = latest
      // Without a URL variable, use the address this request was sent to.
      const baseUrl = (config.url || url.origin).replace(/\/+$/, '')

      return json(200, {
        name: latest.version,
        notes,
        pub_date,
        url: shouldProxyPrivateDownload
          ? `${baseUrl}/download/${encodeURIComponent(platformName)}?update=true`
          : latest.platforms[platform].url
      })
    }

    return noContent()
  }

  exports.releases = async ({ loadCache }) => {
    // Get the latest version from the cache
    const latest = await loadCache()

    if (isBlocked(latest) || !latest.files || !latest.files.RELEASES) {
      return noContent()
    }

    return new Response(latest.files.RELEASES, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' }
    })
  }

  exports.overview = async ({ loadCache }) => {
    const latest = await loadCache()

    if (!latest.version && latest.unavailable) {
      return text(
        503,
        'The latest release could not be loaded from GitHub. Please try again later.',
        { 'Retry-After': String(latest.unavailable.retryAfter) }
      )
    }

    const html = render({
      account: config.account,
      repository: config.repository,
      date: latest.pub_date
        ? distanceInWordsToNow(latest.pub_date, { addSuffix: true })
        : '',
      files: latest.platforms,
      version: latest.version
    })

    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    })
  }

  return exports
}
