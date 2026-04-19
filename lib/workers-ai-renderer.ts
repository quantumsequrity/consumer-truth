/**
 * Workers AI renderer backend for the grounded pipeline.
 *
 * Swaps the LLM that produces layman prose in `gemini-renderer.ts`
 * from Gemini 2.0 Flash to Cloudflare Workers AI (default: Gemma 3 12B).
 * The grounded contract is unchanged — the model still only receives
 * pre-fetched structured facts, and the deterministic verdict/validator
 * layers run identically.
 *
 * OCR stays on Gemini. This module only exists to power the renderer
 * step, which is pure style transfer (JSON facts → natural language).
 */

interface AiBinding {
  run(model: string, input: Record<string, any>): Promise<any>
}

function getCfEnv(): Record<string, any> | null {
  try {
    const { getCloudflareContext } = require('@opennextjs/cloudflare')
    const { env } = getCloudflareContext()
    return env || null
  } catch {
    return null
  }
}

function getAI(): AiBinding | null {
  const env = getCfEnv()
  return env?.AI || null
}

function cfVar(name: string): string | undefined {
  const env = getCfEnv()
  if (env && typeof env[name] === 'string') return env[name] as string
  return process.env[name]
}

const DEFAULT_MODEL = '@cf/google/gemma-4-26b-a4b-it'

export function isWorkersAIRendererEnabled(): boolean {
  return (cfVar('RENDERER_BACKEND') || 'gemini').toLowerCase() === 'gemma'
}

export function workersAIRendererAvailable(): boolean {
  return getAI() !== null
}

/**
 * Runs the renderer prompt against Workers AI and returns the raw text
 * the model emitted. Caller is responsible for JSON parsing — this keeps
 * parity with the Gemini path in `gemini-renderer.ts`.
 *
 * Returns null on any failure so the caller can fall back to Gemini
 * or to the deterministic no-LLM rendering.
 */
export async function callWorkersAIRenderer(prompt: string): Promise<string | null> {
  const ai = getAI()
  if (!ai) {
    console.warn('[WorkersAI Renderer] AI binding not available')
    return null
  }

  const model = cfVar('RENDERER_MODEL') || DEFAULT_MODEL

  try {
    const response = await ai.run(model, {
      messages: [
        {
          role: 'system',
          content:
            'You are a grounded explainer. Output only valid JSON matching the schema in the user prompt. No markdown fences, no prose outside JSON. Keep internal reasoning brief.',
        },
        { role: 'user', content: prompt },
      ],
      // Gemma 4 is a reasoning model: it emits chain-of-thought into
      // `message.reasoning` before the final `message.content`. A small budget
      // exhausts on reasoning alone (finish_reason=length, content=null). 4096
      // is enough for brief reasoning + the ~300-token JSON answer we need.
      max_tokens: 4096,
      temperature: 0.2,
    })

    if (!response) return null

    const text = extractText(response)
    if (!text) {
      const shape = safeShape(response)
      console.warn(`[WorkersAI Renderer] Empty text. shape=${shape}`)
      return null
    }

    return text
  } catch (err) {
    console.warn('[WorkersAI Renderer] Call failed:', (err as Error).message)
    return null
  }
}

function extractText(response: any): string | null {
  if (typeof response === 'string') return response
  if (typeof response.response === 'string') return response.response
  if (response.response?.response && typeof response.response.response === 'string') {
    return response.response.response
  }
  // OpenAI-compat chat completion shape (used by Gemma on Workers AI).
  const msg = Array.isArray(response.choices) ? response.choices[0]?.message : null
  if (msg?.content && typeof msg.content === 'string') return msg.content
  // Reasoning models (Gemma 4) emit content=null when they hit the token
  // budget inside `reasoning`. Last-resort: try to pull a JSON object out of
  // the reasoning stream — the model often writes the intended answer there
  // as a draft before running out of budget.
  if (msg?.reasoning && typeof msg.reasoning === 'string') {
    const jsonMatch = msg.reasoning.match(/\{[\s\S]*"safety_summary"[\s\S]*\}/)
    if (jsonMatch) return jsonMatch[0]
  }
  return null
}

function safeShape(response: any): string {
  try {
    if (response == null) return 'null'
    if (typeof response === 'string') return `string(${response.length})`
    const json = JSON.stringify(response)
    return json.length > 800 ? json.slice(0, 800) + '…' : json
  } catch {
    return `type=${typeof response}`
  }
}
