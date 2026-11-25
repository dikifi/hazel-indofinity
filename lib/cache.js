// Utilities
import checkPlatform from './platform.js'

// GitHub rejects API requests without a User-Agent header, and unlike
// node-fetch, the fetch built into Workers does not send one by default.
export const USER_AGENT = 'hazel-update-server'

const MINUTE = 60 * 1000
const DEFAULT_INTERVAL = 15

// After GitHub failed, it is left alone for a while, and requests are
// answered right away from what is cached (or with "no update"), without
// contacting GitHub. This keeps an expired token from turning every request
// into calls to GitHub.
//
// - Network errors and GitHub server errors are usually over soon.
const TRANSIENT_BACKOFF = MINUTE
// - 401, 403 and 404 mean the token expired, was revoked or lacks access (or
//   ACCOUNT/REPOSITORY are wrong). That does not fix itself, so wait longer.
//   Setting a new token deploys a new version, which starts over right away.
const REJECTED_BACKOFF = 15 * MINUTE
// - Rate limits say when they end, but never wait longer than this.
const MAX_BACKOFF = 60 * MINUTE

// A single request to GitHub never waits longer than this.
const FETCH_TIMEOUT = 10 * 1000

// A refresh that has not finished after this long is treated as abandoned
// (e.g. because the request that started it was cancelled).
const REFRESH_TIMEOUT = 30 * 1000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const clampBackoff = ms =>
  Math.min(Math.max(ms, TRANSIENT_BACKOFF), MAX_BACKOFF)

const configurationError = message => {
  const error = new Error(message)
  error.code = 'missing_configuration_properties'
  return error
}

export class GitHubError extends Error {
  constructor(message, { status = null, backoff = TRANSIENT_BACKOFF } = {}) {
    super(message)
    this.name = 'GitHubError'
    this.status = status
    this.backoff = backoff
  }
}

const backoffFor = response => {
  const { status, headers } = response
  const retryAfter = Number(headers.get('retry-after'))

  if (retryAfter > 0) {
    return clampBackoff(retryAfter * 1000)
  }

  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset')) * 1000

    if (reset > Date.now()) {
      return clampBackoff(reset - Date.now())
    }
  }

  return status >= 500 ? TRANSIENT_BACKOFF : REJECTED_BACKOFF
}

const describeStatus = status => {
  if (status === 401) {
    return 'GitHub rejected the token: it has probably expired or been revoked. Create a new token and run "npx wrangler secret put TOKEN" (or GITHUB_TOKEN)'
  }

  if (status === 403 || status === 429) {
    return 'GitHub refused the request: rate limit reached, or the token has no access to the repository'
  }

  if (status === 404) {
    return 'GitHub could not find the repository or file: check ACCOUNT and REPOSITORY, and that the token can read the repository'
  }

  return 'GitHub could not handle the request'
}

const gitHubError = async (response, url) => {
  let detail = ''

  try {
    detail = (await response.text()).slice(0, 200)
  } catch (err) {}

  return new GitHubError(
    `${describeStatus(response.status)} (status ${response.status} for ${url}: ${detail})`,
    { status: response.status, backoff: backoffFor(response) }
  )
}

const fingerprint = async value => {
  const data = new TextEncoder().encode(value)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))

  return Array.from(digest.slice(0, 6), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

// The cache has two levels:
//
// 1. Memory of the current Worker instance (fastest, but every instance has
//    its own copy and instances come and go).
// 2. The Cache API of the Cloudflare data center, which is shared by all
//    instances in that data center. It only works on a custom domain, not on
//    *.workers.dev (there, only the memory level is used).
//
// GitHub is only asked when neither level holds data younger than INTERVAL,
// and when GitHub has not failed recently (failures are shared, too).
export default class Cache {
  constructor(config) {
    const { account, repository } = config

    if (!account || !repository) {
      throw configurationError('Neither ACCOUNT, nor REPOSITORY are defined')
    }

    const interval = Number(config.interval)

    this.config = config
    this.interval = (interval > 0 ? interval : DEFAULT_INTERVAL) * MINUTE
    this.retryDelay =
      typeof config.retryDelay === 'number' ? config.retryDelay : 500

    this.latest = {}
    this.lastUpdate = null
    this.failure = null
    this.refreshStarted = 0
    this.tokenFingerprint = null

    this.loadCache = this.loadCache.bind(this)
    this.getDownloadLink = this.getDownloadLink.bind(this)
  }

  apiHeaders(accept = 'application/vnd.github+json') {
    const { token, githubToken } = this.config
    const apiToken = token || githubToken
    const headers = { Accept: accept, 'User-Agent': USER_AGENT }

    if (apiToken) {
      headers.Authorization = `token ${apiToken}`
    }

    return headers
  }

  // Retries network errors and GitHub server errors twice. Everything else
  // (an expired token, a rate limit, a missing repository) fails right away,
  // since asking again would not help.
  async fetchWithRetry(url, headers, retries = 2) {
    for (let attempt = 0; ; attempt += 1) {
      let error = null

      try {
        const response = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(FETCH_TIMEOUT)
        })

        if (response.status === 200) {
          return response
        }

        error = await gitHubError(response, url)

        if (response.status < 500) {
          throw error
        }
      } catch (err) {
        if (err === error) {
          throw err
        }

        error = new GitHubError(
          `GitHub could not be reached (${url}): ${err.message}`
        )
      }

      if (attempt >= retries) {
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

  // Asks GitHub for a short-lived download link of an asset of a private
  // repository. Returns `{ location }`, or `{ retryAfter }` (in seconds) when
  // GitHub refused, in which case GitHub is left alone for a while.
  async getDownloadLink(asset, context = {}) {
    let response

    try {
      response = await fetch(asset.api_url, {
        headers: this.apiHeaders('application/octet-stream'),
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT)
      })
    } catch (err) {
      const error = new GitHubError(
        `GitHub could not be reached (${asset.api_url}): ${err.message}`
      )
      return { retryAfter: this.recordFailure(error, context) }
    }

    const location = response.headers.get('Location')

    if (response.status >= 300 && response.status < 400 && location) {
      return { location }
    }

    const error = await gitHubError(response, asset.api_url)
    return { retryAfter: this.recordFailure(error, context) }
  }

  activeFailure() {
    const { failure } = this
    return failure && Date.now() < failure.until ? failure : null
  }

  // Remembers that GitHub failed, here and for the other instances in this
  // data center. Returns the number of seconds until GitHub is asked again.
  recordFailure(error, { origin, waitUntil } = {}) {
    const backoff =
      error instanceof GitHubError ? error.backoff : TRANSIENT_BACKOFF
    const failure = {
      until: Date.now() + backoff,
      status: error instanceof GitHubError ? error.status : null
    }

    this.failure = failure
    console.error(
      `Not contacting GitHub for ${Math.round(backoff / 1000)} seconds. ${error.message}`
    )
    this.writeShared('failure', origin, failure, backoff, waitUntil)

    return Math.ceil(backoff / 1000)
  }

  async sharedCache(kind, origin) {
    // `caches` only exists inside Workers (not in Node.js, used by the tests).
    if (!origin || typeof caches === 'undefined' || !caches.default) {
      return null
    }

    const { account, repository, pre, token, githubToken } = this.config

    // Part of the key, so that a new token does not find the failures
    // recorded for the old one.
    if (this.tokenFingerprint === null) {
      this.tokenFingerprint = await fingerprint(
        `${token || ''}|${githubToken || ''}`
      )
    }

    const key = new URL(`/__hazel/${kind}`, origin)

    key.searchParams.set('account', account)
    key.searchParams.set('repository', repository)
    key.searchParams.set('pre', pre ? '1' : '0')
    key.searchParams.set('token', this.tokenFingerprint)

    return { cache: caches.default, key: key.toString() }
  }

  async readShared(kind, origin) {
    try {
      const shared = await this.sharedCache(kind, origin)
      const response = shared && (await shared.cache.match(shared.key))
      return response ? await response.json() : null
    } catch (err) {
      console.error(err)
      return null
    }
  }

  writeShared(kind, origin, value, maxAge, waitUntil) {
    const write = (async () => {
      const shared = await this.sharedCache(kind, origin)

      if (!shared) {
        return
      }

      const response = new Response(JSON.stringify(value), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `max-age=${Math.ceil(maxAge / 1000)}`
        }
      })

      await shared.cache.put(shared.key, response)
    })().catch(err => {
      console.error(err)
    })

    if (waitUntil) {
      waitUntil(write)
    }
  }

  forgetSharedFailure(origin, waitUntil) {
    const remove = (async () => {
      const shared = await this.sharedCache('failure', origin)

      if (shared) {
        await shared.cache.delete(shared.key)
      }
    })().catch(err => {
      console.error(err)
    })

    if (waitUntil) {
      waitUntil(remove)
    }
  }

  isOutdated() {
    const { lastUpdate, interval } = this
    return !lastUpdate || Date.now() - lastUpdate > interval
  }

  snapshot(failure) {
    const latest = Object.assign({}, this.latest)

    if (failure) {
      latest.unavailable = {
        status: failure.status,
        retryAfter: Math.max(1, Math.ceil((failure.until - Date.now()) / 1000))
      }
    }

    return latest
  }

  // Never throws because of GitHub. When GitHub is failing, the returned
  // object has an `unavailable` property (and holds the release cached
  // earlier, if there is one).
  //
  // `context` comes from the incoming request: `origin` is used for the keys
  // of the shared cache, `waitUntil` lets the shared cache be written after
  // the response has been sent.
  async loadCache(context = {}) {
    const failure = this.activeFailure()

    if (failure) {
      return this.snapshot(failure)
    }

    if (!this.isOutdated()) {
      return this.snapshot()
    }

    // Another request of this instance is refreshing already. Until it is
    // done, the release cached before is good enough.
    if (this.lastUpdate && Date.now() - this.refreshStarted < REFRESH_TIMEOUT) {
      return this.snapshot()
    }

    // Claimed before the first `await`, so that the requests arriving in the
    // meantime see it.
    this.refreshStarted = Date.now()

    try {
      return await this.update(context)
    } finally {
      this.refreshStarted = 0
    }
  }

  async update(context) {
    const { origin, waitUntil } = context
    const sharedFailure = await this.readShared('failure', origin)

    if (sharedFailure && Date.now() < sharedFailure.until) {
      this.failure = sharedFailure
      return this.snapshot(sharedFailure)
    }

    const shared = await this.readShared('release', origin)

    if (
      shared &&
      shared.latest &&
      Date.now() - shared.fetchedAt <= this.interval
    ) {
      this.latest = shared.latest
      this.lastUpdate = shared.fetchedAt
      return this.snapshot()
    }

    try {
      await this.refreshCache()
    } catch (err) {
      this.recordFailure(err, context)
      return this.snapshot(this.failure)
    }

    this.failure = null
    this.writeShared(
      'release',
      origin,
      { latest: this.latest, fetchedAt: this.lastUpdate },
      this.interval,
      waitUntil
    )

    if (sharedFailure) {
      this.forgetSharedFailure(origin, waitUntil)
    }

    return this.snapshot()
  }
}
