import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import Cache from '../lib/cache.js'
import {
  ACCOUNT,
  REPOSITORY,
  mockGitHub,
  release,
  restoreFetch
} from './helpers.js'

const config = { account: ACCOUNT, repository: REPOSITORY, retryDelay: 0 }

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
    cache.lastUpdate -= 16 * 60 * 1000

    assert.equal((await cache.loadCache()).version, 'v1.3.0')
  })

  it('should keep serving the cached release when GitHub fails', async () => {
    const state = {}
    mockGitHub(state)
    const cache = new Cache(config)

    await cache.loadCache()
    cache.lastUpdate -= 16 * 60 * 1000
    state.status = 403

    const originalError = console.error
    console.error = () => {}

    try {
      assert.equal((await cache.loadCache()).version, 'v1.2.0')
    } finally {
      console.error = originalError
    }
  })

  it('should throw when GitHub fails and nothing is cached yet', async () => {
    const calls = mockGitHub({ status: 503 })
    const cache = new Cache(config)

    await assert.rejects(cache.loadCache(), /GitHub responded with 503/)
    // The first try and three retries.
    assert.equal(calls.length, 4)

    // Afterwards, GitHub is left alone for a minute.
    await assert.rejects(cache.loadCache(), /retrying in a minute/)
    assert.equal(calls.length, 4)
  })
})
