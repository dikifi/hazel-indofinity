import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import aliases from '../lib/aliases.js'

describe('Aliases', () => {
  it('Should return the correct platform', () => {
    assert.equal(aliases('mac'), 'darwin')
  })

  it('Should return the platform when the platform is provided', () => {
    assert.equal(aliases('darwin'), 'darwin')
  })

  it('Should return the arm64 platform', () => {
    assert.equal(aliases('mac_arm64'), 'darwin_arm64')
    assert.equal(aliases('dmg_arm64'), 'dmg_arm64')
  })

  it('Should return false if no platform is found', () => {
    assert.equal(aliases('test'), false)
  })
})
