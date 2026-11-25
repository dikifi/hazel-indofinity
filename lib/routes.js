// Packages
import semver from 'semver'
import useragent from 'express-useragent'
import distanceInWordsToNow from 'date-fns/distance_in_words_to_now/index.js'

// Utilities
import checkAlias from './aliases.js'
import render from './view.js'
import { USER_AGENT } from './cache.js'

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  })

const text = (status, body) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  })

const redirect = location =>
  new Response(null, { status: 302, headers: { Location: location } })

const noContent = () => new Response(null, { status: 204 })

export default ({ config }) => {
  const exports = {}
  const { token } = config
  const shouldProxyPrivateDownload =
    token && typeof token === 'string' && token.length > 0

  // Helpers
  const proxyPrivateDownload = async asset => {
    const response = await fetch(asset.api_url, {
      headers: {
        Accept: 'application/octet-stream',
        Authorization: `token ${token}`,
        'User-Agent': USER_AGENT
      },
      redirect: 'manual'
    })
    const location = response.headers.get('Location')

    if (!location) {
      console.error(
        `GitHub responded with ${response.status} instead of a download link for ${asset.api_url}`
      )
      return text(502, 'Could not get a download link from GitHub')
    }

    return redirect(location)
  }

  exports.download = async ({ request, url, loadCache }) => {
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
    const { platforms } = await loadCache()

    if (!platform || !platforms || !platforms[platform]) {
      return text(404, 'No download available for your platform!')
    }

    if (shouldProxyPrivateDownload) {
      return proxyPrivateDownload(platforms[platform])
    }

    return redirect(platforms[platform].url)
  }

  exports.downloadPlatform = async ({ url, params, loadCache }) => {
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

    if (!latest.platforms || !latest.platforms[platform]) {
      return text(404, 'No download available for your platform')
    }

    if (shouldProxyPrivateDownload) {
      return proxyPrivateDownload(latest.platforms[platform])
    }

    return redirect(latest.platforms[platform].url)
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

    if (!latest.platforms || !latest.platforms[platform]) {
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

    if (!latest.files || !latest.files.RELEASES) {
      return noContent()
    }

    return new Response(latest.files.RELEASES, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' }
    })
  }

  exports.overview = async ({ loadCache }) => {
    const latest = await loadCache()

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
