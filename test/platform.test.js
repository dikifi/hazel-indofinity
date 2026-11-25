import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import platform from '../lib/platform.js'

describe('Platform', () => {
  it('Should parse mac', () => {
    assert.equal(platform('hyper-2.1.1-mac.zip'), 'darwin')
  })

  it('Should parse mac arm64', () => {
    assert.equal(platform('hyper-2.1.1-arm64-mac.zip'), 'darwin_arm64')
  })

  it('Should parse other platforms', () => {
    assert.equal(platform('hyper_2.1.1_amd64.deb'), 'deb')
    assert.equal(platform('Hyper-2.1.1.AppImage'), 'AppImage')
    assert.equal(platform('Hyper Setup 2.1.1.exe'), 'exe')
  })

  it('Should parse dmg', () => {
    assert.equal(platform('hyper-2.1.1.dmg'), 'dmg')
  })

  it('Should return false for unknown files', () => {
    assert.equal(platform('hi.txt'), false)
    assert.equal(platform('latest.yml'), false)
    assert.equal(platform('.dmg'), false)
  })
})
