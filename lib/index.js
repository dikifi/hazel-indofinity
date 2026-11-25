// Entry point of the Cloudflare Worker.
import Cache from './cache.js'
import createRoutes from './routes.js'

const plainText = (status, body, headers = {}) =>
  new Response(body, {
    status,
    headers: Object.assign(
      { 'Content-Type': 'text/plain; charset=utf-8' },
      headers
    )
  })

export const configFromEnv = env => ({
  interval: env.INTERVAL,
  account: env.ACCOUNT,
  repository: env.REPOSITORY,
  pre: env.PRE,
  token: env.TOKEN,
  githubToken: env.GITHUB_TOKEN,
  url: env.URL
})

// Matches the same paths as the original Hazel server. Like it, literal path
// parts are case-insensitive and a trailing slash is ignored.
const findRoute = (routes, segments) => {
  const [first = '', second = '', third, fourth = ''] = segments
  const count = segments.length

  if (count === 0) {
    return [routes.overview, {}]
  }

  if (first.toLowerCase() === 'download') {
    if (count === 1) {
      return [routes.download, {}]
    }

    if (count === 2) {
      return [routes.downloadPlatform, { platform: second }]
    }
  }

  if (first.toLowerCase() === 'update') {
    if (count === 3) {
      return [routes.update, { platform: second, version: third }]
    }

    if (
      count === 4 &&
      second.toLowerCase() === 'win32' &&
      fourth.toLowerCase() === 'releases'
    ) {
      return [routes.releases, { version: third }]
    }
  }

  return null
}

export const createHandler = config => {
  let cache = null

  try {
    cache = new Cache(config)
  } catch (err) {
    const { code, message } = err

    if (code) {
      return async () =>
        new Response(JSON.stringify({ error: { code, message } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        })
    }

    throw err
  }

  const routes = createRoutes({ config })

  const handle = async (request, ctx) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return plainText(405, 'Method Not Allowed', { Allow: 'GET, HEAD' })
    }

    const url = new URL(request.url)
    let segments

    try {
      segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    } catch (err) {
      return plainText(400, 'Bad Request')
    }

    const route = findRoute(routes, segments)

    if (!route) {
      return plainText(404, 'Not Found')
    }

    const [handler, params] = route
    const waitUntil =
      ctx && typeof ctx.waitUntil === 'function'
        ? promise => ctx.waitUntil(promise)
        : null
    const context = { origin: url.origin, waitUntil }
    const loadCache = () => cache.loadCache(context)
    const getDownloadLink = asset => cache.getDownloadLink(asset, context)

    try {
      return await handler({ request, url, params, loadCache, getDownloadLink })
    } catch (err) {
      console.error(err)
      return plainText(500, 'Internal Server Error')
    }
  }

  // Exposed for the tests.
  handle.cache = cache

  return handle
}

// One handler per Worker instance, so that the in-memory cache is kept
// between requests served by that instance.
let handler = null

export default {
  async fetch(request, env, ctx) {
    if (!handler) {
      handler = createHandler(configFromEnv(env))
    }

    return handler(request, ctx)
  }
}
