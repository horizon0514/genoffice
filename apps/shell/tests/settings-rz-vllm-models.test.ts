/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAiSettings } from '@genoffice/ai-provider'
import type { AiSettings, CodexModelCatalog } from '@genoffice/ai-provider'
import type { HomeApi } from '../src/shared/home-api'
import { LocaleProvider } from '../src/renderer/src/locale'
import { SettingsModal } from '../src/renderer/src/SettingsModal'

const BASE_URL = 'http://127.0.0.1:8000/v1'
const DEBOUNCE_MS = 400

let host: HTMLDivElement
let root: Root
let calls: Array<{ baseUrl: string; apiKey: string | undefined; resolve: (c: CodexModelCatalog) => void }>

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  vi.useFakeTimers()
  calls = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function storedSettings(): AiSettings {
  const s = defaultAiSettings()
  s.provider = 'rz-vllm' as AiSettings['provider']
  s.providers['rz-vllm' as keyof AiSettings['providers']] = {
    apiKey: '',
    model: '',
    baseUrl: BASE_URL,
  } as unknown as AiSettings['providers'][keyof AiSettings['providers']]
  return s
}

function installApi(settings: AiSettings): void {
  window.aiOffice = {
    getTheme: async () => 'system',
    getDefaultSaveDir: async () => '',
    getAnalyticsEnabled: async () => true,
    setAnalyticsEnabled: async () => true,
    getAiPanelPrefs: async () => ({ fontSize: 'medium', customFontSize: 14, spellcheck: true }),
    setAiPanelPrefs: async (patch: unknown) => patch,
    getUpdateChannel: async () => 'stable',
    getAppVersion: async () => '1.0.0',
    githubStars: async () => null,
    getAiProviders: () => [
      { id: 'genspark', label: 'Genspark', models: [], defaultModel: '', keyPlaceholder: 'k', defaultBaseUrl: '' },
      { id: 'rz-vllm', label: 'RZ vLLM', models: [], defaultModel: '', keyPlaceholder: 'API Key', needsBaseUrl: true, defaultBaseUrl: '' },
    ],
    getAiSettings: async () => settings,
    setAiSettings: vi.fn(async () => undefined),
    getCustomModels: (baseUrl: string, apiKey?: string) =>
      new Promise<CodexModelCatalog>((resolve) => calls.push({ baseUrl, apiKey, resolve })),
  } as unknown as HomeApi
}

async function openAiPane(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        LocaleProvider,
        { initial: 'en' },
        createElement(SettingsModal, {
          status: null,
          loggingOut: false,
          loginWaiting: false,
          loginUrl: null,
          urlCopied: false,
          onOpenLoginUrl: vi.fn(),
          onCopyLoginUrl: vi.fn(),
          onClose: vi.fn(),
          onLogin: vi.fn(),
          onLogout: vi.fn(),
        }),
      ),
    )
    await Promise.resolve()
  })
  // Open AI Model section
  const nav = Array.from(host.querySelectorAll<HTMLButtonElement>('.set-nav-item')).find((button) =>
    button.textContent?.includes('AI Model'),
  )
  await act(async () => {
    nav!.click()
    await Promise.resolve()
  })
}

async function tick(ms = DEBOUNCE_MS): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function answer(index: number, models: string[]): Promise<void> {
  await act(async () => {
    calls[index]!.resolve({ models, defaultModel: '' })
    await Promise.resolve()
  })
}

function picker(label: string): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>(`.gs-dd-btn[aria-label="${label}"]`)
}

async function modelOptions(): Promise<string[]> {
  const trigger = picker('Model')!
  await act(async () => trigger.click())
  const options = Array.from(host.querySelectorAll<HTMLButtonElement>('.gs-dd-pop [role="option"]'))
  const labels = options.map((option) => option.getAttribute('aria-label') ?? option.textContent!)
  await act(async () => trigger.click())
  return labels
}

describe('rz-vllm provider model list', () => {
  it('probes /models and turns the Model field into a picker', async () => {
    installApi(storedSettings())
    await openAiPane()
    // Debounce window elapses and probes fire
    await tick()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.baseUrl).toBe(BASE_URL)
    await answer(0, ['a', 'b', 'c'])
    // After reply, Model field becomes a dropdown with the server-provided ids
    expect(await modelOptions()).toEqual(['a', 'b', 'c'])
  })
})

