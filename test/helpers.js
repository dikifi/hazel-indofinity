// A fake GitHub, so that the tests run without network access.
const realFetch = globalThis.fetch

export const ACCOUNT = 'acme'
export const REPOSITORY = 'app'

let assetId = 0

const asset = (tag, name) => {
  assetId += 1

  return {
    name,
    url: `https://api.github.com/repos/${ACCOUNT}/${REPOSITORY}/releases/assets/${assetId}`,
    browser_download_url: `https://github.com/${ACCOUNT}/${REPOSITORY}/releases/download/${tag}/${name}`,
    content_type: 'application/octet-stream',
    size: 87654321
  }
}

export const release = (tag, { prerelease = false, draft = false } = {}) => {
  const version = tag.replace(/^v/, '')

  return {
    tag_name: tag,
    prerelease,
    draft,
    body: `Notes for ${tag}`,
    published_at: '2026-11-01T00:00:00Z',
    assets: [
      asset(tag, `IndoFinity-${version}-mac.zip`),
      asset(tag, `IndoFinity-${version}-arm64-mac.zip`),
      asset(tag, `IndoFinity-${version}.dmg`),
      asset(tag, `IndoFinity-Setup-${version}.exe`),
      asset(tag, `IndoFinity-${version}-full.nupkg`),
      asset(tag, 'RELEASES'),
      asset(tag, 'latest.yml')
    ]
  }
}

export const RELEASES_FILE = tag =>
  `ABCDEF0123456789 IndoFinity-${tag.replace(/^v/, '')}-full.nupkg 87654321`

// Replaces the global fetch with a fake GitHub. `state` can be changed by a
// test while it runs, e.g. to publish a new release or to make GitHub fail:
//
// - `status`: every request fails with this status (e.g. 401 for an expired
//   token), with the extra response `headers`
// - `assetStatus`: only requests for download links of assets fail
// - `delay`: milliseconds the list of releases takes to arrive
export const mockGitHub = (state = {}) => {
  const calls = []
  const releasesUrl = `https://api.github.com/repos/${ACCOUNT}/${REPOSITORY}/releases?`

  state.releases = state.releases || [release('v1.2.0')]

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    calls.push({ url, init })

    if (state.status) {
      return new Response('{"message":"Bad credentials"}', {
        status: state.status,
        headers: state.headers || {}
      })
    }

    if (url.startsWith(releasesUrl)) {
      if (state.delay) {
        await new Promise(resolve => setTimeout(resolve, state.delay))
      }

      const perPage = Number(new URL(url).searchParams.get('per_page'))
      return Response.json(state.releases.slice(0, perPage))
    }

    if (url.endsWith('/RELEASES')) {
      const tag = url.split('/').slice(-2)[0]
      return new Response(RELEASES_FILE(tag))
    }

    if (url.includes('/releases/assets/')) {
      if (state.assetStatus) {
        return new Response('{"message":"Bad credentials"}', {
          status: state.assetStatus
        })
      }

      return new Response(null, {
        status: 302,
        headers: { Location: 'https://objects.example.com/signed-download' }
      })
    }

    return new Response('Not Found', { status: 404 })
  }

  return calls
}

// Collects what is logged with console.error instead of printing it.
export const captureErrors = t => {
  const messages = []
  t.mock.method(console, 'error', (...args) => {
    messages.push(args.map(String).join(' '))
  })
  return messages
}

// Makes the cached release look older than INTERVAL (15 minutes).
export const age = (cache, minutes = 16) => {
  cache.lastUpdate -= minutes * 60 * 1000
}

export const restoreFetch = () => {
  globalThis.fetch = realFetch
}
