import { describe, expect, it } from 'vitest'
import { resolveNamingProvider } from '../src/main/ai-naming-provider'

/**
 * The naming service used to resolve its provider on its own: a hardcoded list
 * of three ids, and the key read out of the settings file. That list did not
 * know every provider the build can talk to, so for the default account the
 * call failed and the feature quietly did nothing.
 *
 * These assertions are the evidence that the provider is now resolved the way
 * the rest of the app resolves it.
 */

describe('resolveNamingProvider', () => {
  it('uses the shipped RZ vLLM default when nothing is configured', () => {
    const resolved = resolveNamingProvider({}, 'gsk-live-key')
    expect(resolved?.provider).toBe('rz-vllm')
    expect(resolved?.config.apiKey).toBe('123456')
    expect(resolved?.config.baseUrl).toBe('http://192.168.2.70:9000/v1')
    expect(resolved?.config.model).toBe('qwen3.8-27b')
  })

  it('does not need a Genspark sign-in for the default provider', () => {
    expect(resolveNamingProvider({}, '')?.provider).toBe('rz-vllm')
  })

  it('still resolves the default when the settings file could not be read', () => {
    expect(resolveNamingProvider(null, '')?.provider).toBe('rz-vllm')
  })

  it('honors a configured provider', () => {
    const resolved = resolveNamingProvider(
      {
        provider: 'anthropic',
        providers: { anthropic: { apiKey: 'sk-ant', model: 'claude-sonnet-4-6' } },
      },
      '',
    )
    expect(resolved?.provider).toBe('anthropic')
    expect(resolved?.config.apiKey).toBe('sk-ant')
    expect(resolved?.config.model).toBe('claude-sonnet-4-6')
  })

  it('falls back to RZ vLLM when the configured provider is half-filled', () => {
    const resolved = resolveNamingProvider(
      {
        provider: 'anthropic',
        providers: { anthropic: { apiKey: 'sk-ant', model: '' } },
      },
      'gsk-live-key',
    )
    expect(resolved?.provider).toBe('rz-vllm')
    expect(resolved?.config.apiKey).toBe('123456')
  })

  it('falls back to RZ vLLM for a provider this build does not have', () => {
    const resolved = resolveNamingProvider(
      { provider: 'not-a-provider', providers: {} },
      'gsk-live-key',
    )
    expect(resolved?.provider).toBe('rz-vllm')
  })

  it('moves a hidden provider back to the shipped default', () => {
    const resolved = resolveNamingProvider(
      { provider: 'genspark', providers: { genspark: { apiKey: 'gsk-live-key', model: 'x' } } },
      'gsk-live-key',
    )
    expect(resolved?.provider).toBe('rz-vllm')
  })

  it('does not need a key for codex', () => {
    const resolved = resolveNamingProvider({ provider: 'codex', providers: {} }, '')
    expect(resolved?.provider).toBe('codex')
  })

  it("resolves a custom endpoint's key from the environment", () => {
    process.env.GENOFFICE_NAMING_TEST_KEY = 'from-env'
    try {
      const resolved = resolveNamingProvider(
        {
          provider: 'custom',
          providers: {
            custom: {
              apiKey: '',
              model: 'local-model',
              baseUrl: 'http://127.0.0.1:11434/v1',
              profile: { apiKeyEnv: 'GENOFFICE_NAMING_TEST_KEY' },
            },
          },
        },
        '',
      )
      expect(resolved?.provider).toBe('custom')
      expect(resolved?.config.apiKey).toBe('from-env')
    } finally {
      delete process.env.GENOFFICE_NAMING_TEST_KEY
    }
  })
})
