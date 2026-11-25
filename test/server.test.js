import { describe, it, before, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import worker, { createHandler } from '../lib/index.js'
import { ACCOUNT, REPOSITORY, mockGitHub, restoreFetch } from './helpers.js'

const ORIGIN = 'https://updater.example.com'
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

const get = (handler, path, headers = {}) =>
  handler(new Request(ORIGIN + path, { headers }))

const DOWNLOAD = 'https://github.com/acme/app/releases/download/v1.2.0/'

describe('Server', () => {
  let handler

  before(() => {
    mockGitHub()
    handler = createHandler({
      account: ACCOUNT,
      repository: REPOSITORY,
      retryDelay: 0
    })
  })

  afterEach(() => mockGitHub())

  it('should report missing configuration', async () => {
    const response = await worker.fetch(new Request(ORIGIN + '/'), {}, {})

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: {
        code: 'missing_configuration_properties',
        message: 'Neither ACCOUNT, nor REPOSITORY are defined'
      }
    })
  })

  it('should show the overview page', async () => {
    const response = await get(handler, '/')
    const html = await response.text()

    assert.equal(response.status, 200)
    assert.match(response.headers.get('Content-Type'), /text\/html/)
    assert.match(html, /<title>acme\/app<\/title>/)
    assert.match(html, /<div id="version">v1\.2\.0<\/div>/)
    assert.match(
      html,
      /<a href="https:\/\/github\.com\/acme\/app\/releases\/download\/v1\.2\.0\/IndoFinity-1\.2\.0\.dmg">Download IndoFinity<\/a>/
    )
    assert.match(html, /87\.7 MB/)
  })

  it('should offer an update to a different version', async () => {
    const response = await get(handler, '/update/darwin/1.1.0')

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      name: 'v1.2.0',
      notes: 'Notes for v1.2.0',
      pub_date: '2026-11-01T00:00:00Z',
      url: DOWNLOAD + 'IndoFinity-1.2.0-mac.zip'
    })
  })

  it('should resolve platform aliases', async () => {
    const response = await get(handler, '/update/win32/1.1.0')
    assert.equal(
      (await response.json()).url,
      DOWNLOAD + 'IndoFinity-Setup-1.2.0.exe'
    )

    const arm = await get(handler, '/update/mac_arm64/1.1.0')
    assert.equal(
      (await arm.json()).url,
      DOWNLOAD + 'IndoFinity-1.2.0-arm64-mac.zip'
    )
  })

  it('should not offer an update to the same version', async () => {
    assert.equal((await get(handler, '/update/darwin/1.2.0')).status, 204)
  })

  it('should answer 204 for a platform without files', async () => {
    assert.equal((await get(handler, '/update/deb/1.1.0')).status, 204)
  })

  it('should reject invalid versions and platforms', async () => {
    const version = await get(handler, '/update/darwin/latest')
    assert.equal(version.status, 500)
    assert.equal((await version.json()).error, 'version_invalid')

    const platform = await get(handler, '/update/amiga/1.0.0')
    assert.equal(platform.status, 500)
    assert.equal((await platform.json()).error, 'invalid_platform')
  })

  it('should serve RELEASES for Squirrel.Windows', async () => {
    const response = await get(handler, '/update/win32/1.1.0/RELEASES')

    assert.equal(response.status, 200)
    assert.equal(
      await response.text(),
      `ABCDEF0123456789 ${DOWNLOAD}IndoFinity-1.2.0-full.nupkg 87654321`
    )
  })

  it('should redirect downloads of a platform', async () => {
    const dmg = await get(handler, '/download/mac')
    assert.equal(dmg.status, 302)
    assert.equal(dmg.headers.get('Location'), DOWNLOAD + 'IndoFinity-1.2.0.dmg')

    const zip = await get(handler, '/download/mac?update=true')
    assert.equal(
      zip.headers.get('Location'),
      DOWNLOAD + 'IndoFinity-1.2.0-mac.zip'
    )

    const exe = await get(handler, '/download/windows/')
    assert.equal(
      exe.headers.get('Location'),
      DOWNLOAD + 'IndoFinity-Setup-1.2.0.exe'
    )

    assert.equal((await get(handler, '/download/deb')).status, 404)
    assert.equal((await get(handler, '/download/amiga')).status, 500)
  })

  it('should detect the platform from the user agent', async () => {
    const mac = await get(handler, '/download', { 'User-Agent': MAC_UA })
    assert.equal(mac.headers.get('Location'), DOWNLOAD + 'IndoFinity-1.2.0.dmg')

    const windows = await get(handler, '/download', {
      'User-Agent': WINDOWS_UA
    })
    assert.equal(
      windows.headers.get('Location'),
      DOWNLOAD + 'IndoFinity-Setup-1.2.0.exe'
    )

    assert.equal((await get(handler, '/download')).status, 404)
  })

  it('should answer 404 for unknown paths and 405 for other methods', async () => {
    assert.equal((await get(handler, '/nope')).status, 404)
    assert.equal((await get(handler, '/update/darwin')).status, 404)

    const post = await handler(new Request(ORIGIN + '/', { method: 'POST' }))
    assert.equal(post.status, 405)
  })

  it('should answer 500 when GitHub cannot be reached at all', async () => {
    mockGitHub({ status: 503 })
    const fresh = createHandler({
      account: ACCOUNT,
      repository: REPOSITORY,
      retryDelay: 0
    })
    const originalError = console.error
    console.error = () => {}

    try {
      assert.equal((await get(fresh, '/update/darwin/1.0.0')).status, 500)
    } finally {
      console.error = originalError
    }
  })
})

describe('Server in private repo mode', () => {
  let handler
  let calls

  before(() => {
    calls = mockGitHub()
    handler = createHandler({
      account: ACCOUNT,
      repository: REPOSITORY,
      token: 'secret',
      retryDelay: 0
    })
  })

  afterEach(restoreFetch)

  it('should send updates through its own download route', async () => {
    const response = await get(handler, '/update/darwin/1.1.0')

    assert.equal(
      (await response.json()).url,
      `${ORIGIN}/download/darwin?update=true`
    )
  })

  it('should use URL when it is set', async () => {
    const custom = createHandler({
      account: ACCOUNT,
      repository: REPOSITORY,
      token: 'secret',
      url: 'https://updater.example.org/',
      retryDelay: 0
    })
    calls = mockGitHub()
    const response = await get(custom, '/update/darwin/1.1.0')

    assert.equal(
      (await response.json()).url,
      'https://updater.example.org/download/darwin?update=true'
    )
  })

  it('should redirect downloads to the link GitHub hands out', async () => {
    calls = mockGitHub()
    const response = await get(handler, '/download/darwin?update=true')

    assert.equal(response.status, 302)
    assert.equal(
      response.headers.get('Location'),
      'https://objects.example.com/signed-download'
    )

    const assetCall = calls.find(call => call.url.includes('/releases/assets/'))
    assert.equal(assetCall.init.headers.Authorization, 'token secret')
    assert.equal(assetCall.init.headers.Accept, 'application/octet-stream')
    assert.equal(assetCall.init.redirect, 'manual')
  })
})
