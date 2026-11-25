import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import Cache from '../lib/cache.js'
import {
  ACCOUNT,
  REPOSITORY,
  age,
  captureErrors,
  mockGitHub,
  release,
  restoreFetch
} from './helpers.js'

const config = { account: ACCOUNT, repository: REPOSITORY, retryDelay: 0 }
const MINUTE = 60 * 1000

afterEach(restoreFetch)

describe('Cache', () => {
  it('should throw when account is not defined', () => {
    assert.throws(() => new Cache({ repository: 'hyper' }), /ACCOUNT/)
  })

  it('should throw when repository is not defined', () => {
    assert.throws(() => new Cache({ account: 'zeit' }), /REPOSITORY/)
  })

  it('should run without errors when token is defined and url is not', () => {
    new Cache({ account: 'zeit', repository: 'hyper', token: 'abc' })
  })

  it('should refresh the cache', async () => {
    const calls = mockGitHub()
    const storage = await new Cache(config).loadCache()

    assert.equal(storage.version, 'v1.2.0')
    assert.equal(storage.notes, 'Notes for v1.2.0')
    assert.equal(storage.pub_date, '2026-11-01T00:00:00Z')
    assert.equal(storage.unavailable, undefined)
    assert.deepEqual(Object.keys(storage.platforms).sort(), [
      'darwin',
      'darwin_arm64',
      'dmg',
      'exe'
    ])
    assert.equal(
      storage.platforms.dmg.url,
      'https://github.com/acme/app/releases/download/v1.2.0/IndoFinity-1.2.0.dmg'
    )
    assert.equal(storage.platforms.dmg.size, 87.7)
    assert.match(storage.platforms.dmg.api_url, /\/releases\/assets\/\d+$/)

    // GitHub rejects API requests without a User-Agent.
    assert.equal(calls[0].init.headers['User-Agent'], 'hazel-update-server')
    assert.equal(calls[0].init.headers.Authorization, undefined)
    // Requests to GitHub cannot hang.
    assert.ok(calls[0].init.signal instanceof AbortSignal)
  })

  it('should point RELEASES to the full nupkg URL', async () => {
    mockGitHub()
    const storage = await new Cache(config).loadCache()

    assert.equal(
      storage.files.RELEASES,
      'ABCDEF0123456789 https://github.com/acme/app/releases/download/v1.2.0/IndoFinity-1.2.0-full.nupkg 87654321'
    )
  })

  it('should skip drafts and pre-releases', async () => {
    mockGitHub({
      releases: [
        release('v2.0.0', { draft: true }),
        release('v1.3.0-beta.1', { prerelease: true }),
        release('v1.2.0')
      ]
    })

    assert.equal((await new Cache(config).loadCache()).version, 'v1.2.0')
  })

  it('should serve pre-releases only when PRE is set', async () => {
    mockGitHub({
      releases: [
        release('v1.2.0'),
        release('v1.3.0-beta.1', { prerelease: true })
      ]
    })

    const storage = await new Cache({ ...config, pre: '1' }).loadCache()
    assert.equal(storage.version, 'v1.3.0-beta.1')
  })

  it('should look further than the first page of releases', async () => {
    const prereleases = Array.from({ length: 15 }, (_, i) =>
      release(`v1.3.0-beta.${i}`, { prerelease: true })
    )
    const calls = mockGitHub({ releases: [...prereleases, release('v1.2.0')] })

    assert.equal((await new Cache(config).loadCache()).version, 'v1.2.0')
    assert.match(calls[0].url, /per_page=10$/)
    assert.match(calls[1].url, /per_page=100$/)
  })

  it('should authenticate with TOKEN or GITHUB_TOKEN', async () => {
    let calls = mockGitHub()
    await new Cache({ ...config, githubToken: 'public-token' }).loadCache()
    assert.equal(calls[0].init.headers.Authorization, 'token public-token')

    calls = mockGitHub()
    await new Cache({ ...config, token: 'private-token' }).loadCache()
    assert.equal(calls[0].init.headers.Authorization, 'token private-token')
  })

  it('should only ask GitHub again after the interval', async () => {
    const state = {}
    const calls = mockGitHub(state)
    const cache = new Cache({ ...config, interval: '15' })

    await cache.loadCache()
    const callsAfterFirstLoad = calls.length
    await cache.loadCache()
    assert.equal(calls.length, callsAfterFirstLoad)

    state.releases = [release('v1.3.0'), ...state.releases]
    age(cache)

    assert.equal((await cache.loadCache()).version, 'v1.3.0')
  })

  it('should refresh only once when requests arrive at the same time', async () => {
    const state = {}
    const calls = mockGitHub(state)
    const cache = new Cache(config)

    await cache.loadCache()
    age(cache)
    calls.length = 0
    state.delay = 20

    const results = await Promise.all([cache.loadCache(), cache.loadCache()])

    assert.deepEqual(
      results.map(result => result.version),
      ['v1.2.0', 'v1.2.0']
    )
    assert.equal(calls.filter(call => call.url.includes('?per_page')).length, 1)
  })
})

describe('Cache when GitHub fails', () => {
  it('should not retry an expired token, and wait 15 minutes', async t => {
    const errors = captureErrors(t)
    const calls = mockGitHub({ status: 401 })
    const cache = new Cache({ ...config, token: 'expired' })

    const storage = await cache.loadCache()

    assert.equal(calls.length, 1)
    assert.equal(storage.version, undefined)
    assert.equal(storage.unavailable.status, 401)
    assert.ok(Math.abs(storage.unavailable.retryAfter - 15 * 60) <= 1)
    assert.match(errors[0], /token: it has probably expired/)
    assert.match(errors[0], /wrangler secret put TOKEN/)
  })

  it('should not contact GitHub again while waiting', async t => {
    captureErrors(t)
    const calls = mockGitHub({ status: 401 })
    const cache = new Cache({ ...config, token: 'expired' })

    for (let i = 0; i < 1000; i += 1) {
      const storage = await cache.loadCache()
      assert.ok(storage.unavailable)
    }

    assert.equal(calls.length, 1)
  })

  it('should try again after waiting, and recover', async t => {
    captureErrors(t)
    const state = { status: 401 }
    const calls = mockGitHub(state)
    const cache = new Cache({ ...config, token: 'expired' })

    await cache.loadCache()
    cache.failure.until = Date.now() - 1
    delete state.status

    const storage = await cache.loadCache()

    assert.equal(storage.version, 'v1.2.0')
    assert.equal(storage.unavailable, undefined)
    assert.equal(cache.failure, null)
    assert.ok(calls.length > 1)
  })

  it('should keep the release cached before the failure', async t => {
    captureErrors(t)
    const state = {}
    mockGitHub(state)
    const cache = new Cache(config)

    await cache.loadCache()
    age(cache)
    state.status = 401

    const storage = await cache.loadCache()
    assert.equal(storage.version, 'v1.2.0')
    assert.equal(storage.unavailable.status, 401)
  })

  it('should retry server errors twice, then wait a minute', async t => {
    captureErrors(t)
    const calls = mockGitHub({ status: 503 })
    const cache = new Cache(config)

    const storage = await cache.loadCache()

    assert.equal(calls.length, 3)
    assert.ok(Math.abs(storage.unavailable.retryAfter - 60) <= 1)

    await cache.loadCache()
    assert.equal(calls.length, 3)
  })

  it('should wait until a rate limit is over', async t => {
    captureErrors(t)
    const reset = Math.floor((Date.now() + 30 * MINUTE) / 1000)
    const calls = mockGitHub({
      status: 403,
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(reset)
      }
    })

    const storage = await new Cache(config).loadCache()

    assert.equal(calls.length, 1)
    assert.ok(Math.abs(storage.unavailable.retryAfter - 30 * 60) <= 2)
  })

  it('should follow Retry-After, but never wait longer than an hour', async t => {
    captureErrors(t)
    mockGitHub({ status: 429, headers: { 'Retry-After': '120' } })
    let storage = await new Cache(config).loadCache()
    assert.ok(Math.abs(storage.unavailable.retryAfter - 120) <= 1)

    mockGitHub({ status: 429, headers: { 'Retry-After': '86400' } })
    storage = await new Cache(config).loadCache()
    assert.ok(Math.abs(storage.unavailable.retryAfter - 60 * 60) <= 1)
  })

  it('should treat network errors like server errors', async t => {
    captureErrors(t)
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      throw new TypeError('fetch failed')
    }

    const storage = await new Cache(config).loadCache()

    assert.equal(calls, 3)
    assert.equal(storage.unavailable.status, null)
  })

  it('should stop asking GitHub when a download link is refused', async t => {
    captureErrors(t)
    const state = {}
    const calls = mockGitHub(state)
    const cache = new Cache({ ...config, token: 'expired' })
    const { platforms } = await cache.loadCache()

    state.assetStatus = 401
    const link = await cache.getDownloadLink(platforms.dmg)
    assert.ok(Math.abs(link.retryAfter - 15 * 60) <= 1)

    const callsAfterRefusal = calls.length
    const storage = await cache.loadCache()
    assert.equal(storage.unavailable.status, 401)
    assert.equal(calls.length, callsAfterRefusal)
  })

  it('should hand out download links', async () => {
    const calls = mockGitHub()
    const cache = new Cache({ ...config, token: 'secret' })
    const { platforms } = await cache.loadCache()

    assert.deepEqual(await cache.getDownloadLink(platforms.dmg), {
      location: 'https://objects.example.com/signed-download'
    })

    const assetCall = calls.at(-1)
    assert.equal(assetCall.init.headers.Authorization, 'token secret')
    assert.equal(assetCall.init.headers.Accept, 'application/octet-stream')
    assert.equal(assetCall.init.redirect, 'manual')
  })
})
