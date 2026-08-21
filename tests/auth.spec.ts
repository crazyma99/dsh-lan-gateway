import { describe, expect, it } from 'vitest'
import { credentialsMatch, parseBasicAuth } from '../src/auth.ts'

const expected = { username: 'dsh', password: 's3cret' }

describe('parseBasicAuth', () => {
  it('decodes a standard Basic header', () => {
    expect(parseBasicAuth('Basic ZHNoOnMzY3JldA==')).toEqual({ username: 'dsh', password: 's3cret' })
  })

  it('keeps colons inside the password', () => {
    const encoded = Buffer.from('dsh:p:a:ss').toString('base64')
    expect(parseBasicAuth(`basic ${encoded}`)).toEqual({ username: 'dsh', password: 'p:a:ss' })
  })

  it('rejects absent, non-Basic, and malformed headers', () => {
    expect(parseBasicAuth(undefined)).toBeUndefined()
    expect(parseBasicAuth('Bearer token')).toBeUndefined()
    expect(parseBasicAuth('Basic !!!not-base64!!!')).toBeUndefined()
    expect(parseBasicAuth('Basic d2l0aG91dGNvbG9u')).toBeUndefined() // no colon
  })
})

describe('credentialsMatch', () => {
  it('accepts exact credentials', () => {
    expect(credentialsMatch({ username: 'dsh', password: 's3cret' }, expected)).toBe(true)
  })

  it('rejects wrong password, wrong username, and absent credentials', () => {
    expect(credentialsMatch({ username: 'dsh', password: 'wrong' }, expected)).toBe(false)
    expect(credentialsMatch({ username: 'admin', password: 's3cret' }, expected)).toBe(false)
    expect(credentialsMatch(undefined, expected)).toBe(false)
  })

  it('is not fooled by length alone', () => {
    expect(credentialsMatch({ username: 'dsh', password: 'SECRET' }, expected)).toBe(false)
  })
})
