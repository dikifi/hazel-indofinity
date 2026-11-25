// Utilities
import checkPlatform from './platform.js'

// GitHub rejects API requests without a User-Agent header, and unlike
// node-fetch, the fetch built into Workers does not send one by default.
export const USER_AGENT = 'hazel-update-server'

const DEFAULT_INTERVAL = 15

// After a failed refresh, wait this long before asking GitHub again. In the
// meantime the release cached earlier (if any) keeps being served.
const FAILURE_BACKOFF = 60 * 1000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const configurationError = message => {
  const error = new Error(message)
  error.code = 'missing_configuration_properties'
  return error
}

// The cache has two levels:
//
// 1. Memory of the current Worker instance (fastest, but every instance has
//    its own copy and instances come and go).
// 2. The Cache API of the Cloudflare data center, which is shared by all
//    instances in that data center. It only works on a custom domain, not on
//    *.workers.dev (there, only the memory level is used).
//
// GitHub is only asked when neither level holds data younger than INTERVAL.
export default class Cache {
  constructor(config) {
    const { account, repository } = config

    if (!account || !repository) {
      throw configurationError('Neither ACCOUNT, nor REPOSITORY are defined')
    }

    const interval = Number(config.interval)

    this.config = config
    this.interval = (interval > 0 ? interval : DEFAULT_INTERVAL) * 60 * 1000
    this.retryDelay =
      typeof config.retryDelay === 'number' ? config.retryDelay : 1000

    this.latest = {}
    this.lastUpdate = null
    this.retryAfter = 0

    this.loadCache = this.loadCache.bind(this)
  }

  apiHeaders() {
    const { token, githubToken } = this.config
    const apiToken = token || githubToken
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT
    }

    if (apiToken) {
      headers.Authorization = `token ${apiToken}`
    }

    return headers
  }

  async fetchWithRetry(url, headers, retries = 3) {
    for (let attempt = 0; ; attempt += 1) {
      let response = null
      let error = null

      try {
        response = await fetch(url, { headers })

        if (response.status === 200) {
          return response
        }

        const body = (await response.text()).slice(0, 200)
        error = new Error(
          `GitHub responded with ${response.status} for url ${url}: ${body}`
        )
      } catch (err) {
        error = err
      }

      // Retrying only helps for network errors and server-side failures.
      const retryable =
        !response || response.status >= 500 || response.status === 429

      if (!retryable || attempt >= retries) {
        throw error
      }

      await sleep(this.retryDelay * 2 ** attempt)
    }
  }

  async cacheReleaseList(url) {
    const { token } = this.config
    const headers = { 'User-Agent': USER_AGENT }

    if (token) {
      headers.Authorization = `token ${token}`
    }

    const response = await this.fetchWithRetry(url, headers)
    let content = await response.text()
    const matches = content.match(/[^ ]*\.nupkg/gim)

    if (!matches) {
      throw new Error(
        `Tried to cache RELEASES, but failed. RELEASES content doesn't contain nupkg`
      )
    }

    for (const match of matches) {
      const nuPKG = url.replace('RELEASES', match)
      content = content.replace(match, nuPKG)
    }

    return content
  }

  async findRelease() {
    const { account, repository, pre } = this.config
    const repo = account + '/' + repository
    const isWanted = item =>
      !item.draft && Boolean(pre) === Boolean(item.prerelease)

    // Ask for a short page first: parsing the full list of 100 releases takes
    // noticeable CPU time, which is limited on Workers (10 ms on the free
    // plan). The full page is only needed if the short one has no match.
    for (const perPage of [10, 100]) {
      const url = `https://api.github.com/repos/${repo}/releases?per_page=${perPage}`
      const response = await this.fetchWithRetry(url, this.apiHeaders())
      const data = await response.json()

      if (!Array.isArray(data) || data.length === 0) {
        return null
      }

      const release = data.find(isWanted)

      if (release) {
        return Array.isArray(release.assets) ? release : null
      }

      if (data.length < perPage) {
        return null
      }
    }

    return null
  }

  async refreshCache() {
    const release = await this.findRelease()

    if (!release) {
      this.lastUpdate = Date.now()
      return
    }

    const { tag_name } = release

    if (this.latest.version === tag_name) {
      console.log('Cached version is the same as latest')
      this.lastUpdate = Date.now()
      return
    }

    console.log(`Caching version ${tag_name}...`)

    const latest = {
      version: tag_name,
      notes: release.body,
      pub_date: release.published_at,
      platforms: {}
    }

    for (const asset of release.assets) {
      const { name, browser_download_url, url, content_type, size } = asset

      if (name === 'RELEASES') {
        try {
          latest.files = {
            RELEASES: await this.cacheReleaseList(browser_download_url)
          }
        } catch (err) {
          console.error(err)
        }
        continue
      }

      const platform = checkPlatform(name)

      if (!platform) {
        continue
      }

      latest.platforms[platform] = {
        name,
        api_url: url,
        url: browser_download_url,
        content_type,
        size: Math.round((size / 1000000) * 10) / 10
      }
    }

    // Replace the cached release in one step, so that requests running at
    // the same time never see a half-filled release.
    this.latest = latest
    this.lastUpdate = Date.now()

    console.log(`Finished caching version ${tag_name}`)
  }

  sharedCacheKey(origin) {
    const { account, repository, pre } = this.config
    const key = new URL('/__hazel/cache', origin)

    key.searchParams.set('account', account)
    key.searchParams.set('repository', repository)
    key.searchParams.set('pre', pre ? '1' : '0')

    return key.toString()
  }

  sharedCache(origin) {
    // `caches` only exists inside Workers (not in Node.js, used by the tests).
    if (!origin || typeof caches === 'undefined' || !caches.default) {
      return null
    }

    return { cache: caches.default, key: this.sharedCacheKey(origin) }
  }

  async readShared(origin) {
    const shared = this.sharedCache(origin)

    if (!shared) {
      return false
    }

    try {
      const response = await shared.cache.match(shared.key)

      if (!response) {
        return false
      }

      const { latest, fetchedAt } = await response.json()

      if (!latest || Date.now() - fetchedAt > this.interval) {
        return false
      }

      this.latest = latest
      this.lastUpdate = fetchedAt
      return true
    } catch (err) {
      console.error(err)
      return false
    }
  }

  writeShared(origin, waitUntil) {
    const shared = this.sharedCache(origin)

    if (!shared) {
      return
    }

    const body = JSON.stringify({
      latest: this.latest,
      fetchedAt: this.lastUpdate
    })
    const response = new Response(body, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `max-age=${Math.ceil(this.interval / 1000)}`
      }
    })
    const write = shared.cache.put(shared.key, response).catch(err => {
      console.error(err)
    })

    if (waitUntil) {
      waitUntil(write)
    }
  }

  isOutdated() {
    const { lastUpdate, interval } = this
    return !lastUpdate || Date.now() - lastUpdate > interval
  }

  // `context` comes from the incoming request: `origin` is used for the key
  // of the shared cache, `waitUntil` lets the shared cache be written after
  // the response has been sent.
  async loadCache(context = {}) {
    const { origin, waitUntil } = context

    if (!this.isOutdated()) {
      return Object.assign({}, this.latest)
    }

    if (Date.now() < this.retryAfter) {
      if (!this.lastUpdate) {
        throw new Error('GitHub could not be reached, retrying in a minute')
      }

      return Object.assign({}, this.latest)
    }

    try {
      if (!(await this.readShared(origin))) {
        await this.refreshCache()
        this.writeShared(origin, waitUntil)
      }
    } catch (err) {
      this.retryAfter = Date.now() + FAILURE_BACKOFF

      if (!this.lastUpdate) {
        throw err
      }

      console.error(
        `Refreshing failed, serving the cached version ${this.latest.version}`,
        err
      )
    }

    return Object.assign({}, this.latest)
  }
}
