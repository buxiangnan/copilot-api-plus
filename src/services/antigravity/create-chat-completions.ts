/**
 * Google Antigravity Chat Completions
 *
 * Proxy chat completion requests to Google Antigravity API.
 * Based on: https://github.com/liuw1535/antigravity2api-nodejs
 */

import consola from "consola"

import {
  getValidAccessToken,
  rotateAccount,
  disableCurrentAccount,
} from "./auth"
import { isThinkingModel } from "./get-models"

// Antigravity API endpoints
const ANTIGRAVITY_API_HOST = "daily-cloudcode-pa.sandbox.googleapis.com"
const ANTIGRAVITY_STREAM_URL = `https://${ANTIGRAVITY_API_HOST}/v1internal:streamGenerateContent?alt=sse`
const ANTIGRAVITY_NO_STREAM_URL = `https://${ANTIGRAVITY_API_HOST}/v1internal:generateContent`
const ANTIGRAVITY_USER_AGENT = "antigravity/1.11.3 windows/amd64"

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content:
    | string
    | Array<{ type: string; text?: string; image_url?: { url: string } }>
}

export interface ChatCompletionRequest {
  model: string
  messages: Array<ChatMessage>
  stream?: boolean
  temperature?: number
  max_tokens?: number
  top_p?: number
  top_k?: number
  tools?: Array<unknown>
}

/**
 * Convert OpenAI format messages to Antigravity format
 */
function convertMessages(messages: Array<ChatMessage>): {
  contents: Array<unknown>
  systemInstruction?: unknown
} {
  const contents: Array<unknown> = []
  let systemInstruction: unknown = undefined

  for (const message of messages) {
    if (message.role === "system") {
      // System message becomes systemInstruction
      const text =
        typeof message.content === "string" ?
          message.content
        : message.content.map((c) => c.text || "").join("")

      systemInstruction = {
        role: "user",
        parts: [{ text }],
      }
      continue
    }

    const role = message.role === "assistant" ? "model" : "user"

    if (typeof message.content === "string") {
      contents.push({
        role,
        parts: [{ text: message.content }],
      })
    } else {
      // Handle multimodal content
      const parts: Array<unknown> = []

      for (const part of message.content) {
        if (part.type === "text") {
          parts.push({ text: part.text })
        } else if (part.type === "image_url" && part.image_url?.url) {
          // Extract base64 image data
          const url = part.image_url.url
          if (url.startsWith("data:")) {
            const match = url.match(/^data:([^;]+);base64,(.+)$/)
            if (match) {
              parts.push({
                inlineData: {
                  mimeType: match[1],
                  data: match[2],
                },
              })
            }
          }
        }
      }

      contents.push({ role, parts })
    }
  }

  return { contents, systemInstruction }
}

/**
 * Convert tools to Antigravity format
 */
function convertTools(tools?: Array<unknown>): Array<unknown> | undefined {
  if (!tools || tools.length === 0) {
    return undefined
  }

  return tools.map((tool: unknown) => {
    const t = tool as {
      type: string
      function?: { name: string; description?: string; parameters?: unknown }
    }
    if (t.type === "function" && t.function) {
      return {
        functionDeclarations: [
          {
            name: t.function.name,
            description: t.function.description || "",
            parameters: t.function.parameters || {},
          },
        ],
      }
    }
    return tool
  })
}

/**
 * Create chat completion with Antigravity
 */
export async function createAntigravityChatCompletion(
  request: ChatCompletionRequest,
): Promise<Response> {
  const accessToken = await getValidAccessToken()

  if (!accessToken) {
    return new Response(
      JSON.stringify({
        error: {
          message:
            "No valid Antigravity access token available. Please run login first.",
          type: "auth_error",
        },
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    )
  }

  const { contents, systemInstruction } = convertMessages(request.messages)
  const tools = convertTools(request.tools)

  // Build Antigravity request body
  const antigravityRequest: Record<string, unknown> = {
    model: request.model,
    contents,
    generationConfig: {
      temperature: request.temperature ?? 1,
      topP: request.top_p ?? 0.85,
      topK: request.top_k ?? 50,
      maxOutputTokens: request.max_tokens ?? 8096,
    },
  }

  if (systemInstruction) {
    antigravityRequest.systemInstruction = systemInstruction
  }

  if (tools) {
    antigravityRequest.tools = tools
  }

  // Enable thinking for thinking models
  if (isThinkingModel(request.model)) {
    antigravityRequest.generationConfig = {
      ...(antigravityRequest.generationConfig as Record<string, unknown>),
      thinkingConfig: {
        includeThoughts: true,
      },
    }
  }

  const endpoint =
    request.stream ? ANTIGRAVITY_STREAM_URL : ANTIGRAVITY_NO_STREAM_URL

  consola.debug(
    `Antigravity request to ${endpoint} with model ${request.model}`,
  )

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Host: ANTIGRAVITY_API_HOST,
        "User-Agent": ANTIGRAVITY_USER_AGENT,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip",
      },
      body: JSON.stringify(antigravityRequest),
    })

    if (!response.ok) {
      const errorText = await response.text()
      consola.error(`Antigravity error: ${response.status} ${errorText}`)

      // Handle 403 - token might be invalid
      if (response.status === 403) {
        await disableCurrentAccount()
      }

      // Rotate to next account for certain errors
      if (response.status === 429 || response.status === 503) {
        await rotateAccount()
      }

      return new Response(
        JSON.stringify({
          error: {
            message: `Antigravity API error: ${response.status}`,
            type: "api_error",
            details: errorText,
          },
        }),
        {
          status: response.status,
          headers: { "Content-Type": "application/json" },
        },
      )
    }

    if (request.stream) {
      // Transform SSE stream to OpenAI format
      return transformStreamResponse(response, request.model)
    } else {
      // Transform non-stream response to OpenAI format
      return transformNonStreamResponse(response, request.model)
    }
  } catch (error) {
    consola.error("Antigravity request error:", error)
    return new Response(
      JSON.stringify({
        error: {
          message: `Request failed: ${error}`,
          type: "request_error",
        },
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    )
  }
}

/**
 * Transform Antigravity stream response to OpenAI format
 */
function transformStreamResponse(response: Response, model: string): Response {
  const reader = response.body?.getReader()

  if (!reader) {
    return new Response("No response body", { status: 500 })
  }

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const stream = new ReadableStream({
    async start(controller) {
      let buffer = ""
      const requestId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

      try {
        while (true) {
          const { done, value } = await reader.read()

          if (done) {
            // Send final done message
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
            break
          }

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() || ""

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6).trim()

              if (data === "[DONE]" || data === "") {
                continue
              }

              try {
                const parsed = JSON.parse(data) as {
                  response?: {
                    candidates?: Array<{
                      content?: {
                        parts?: Array<{
                          text?: string
                          thought?: boolean
                          functionCall?: { name: string; args: unknown }
                        }>
                      }
                      finishReason?: string
                    }>
                  }
                  candidates?: Array<{
                    content?: {
                      parts?: Array<{
                        text?: string
                        thought?: boolean
                        functionCall?: { name: string; args: unknown }
                      }>
                    }
                    finishReason?: string
                  }>
                }

                // Handle both response wrapper and direct candidates
                const candidates =
                  parsed.response?.candidates || parsed.candidates
                const candidate = candidates?.[0]
                const parts = candidate?.content?.parts || []

                for (const part of parts) {
                  // Handle thinking/thought content
                  if (part.thought && part.text) {
                    // Send thinking content with reasoning_content field (for clients that support it)
                    const chunk = {
                      id: requestId,
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model,
                      choices: [
                        {
                          index: 0,
                          delta: {
                            reasoning_content: part.text,
                          },
                          finish_reason: null,
                        },
                      ],
                    }

                    controller.enqueue(
                      encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
                    )
                    continue
                  }

                  // Handle regular text content
                  if (part.text) {
                    const chunk = {
                      id: requestId,
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model,
                      choices: [
                        {
                          index: 0,
                          delta: {
                            content: part.text,
                          },
                          finish_reason:
                            candidate?.finishReason === "STOP" ? "stop" : null,
                        },
                      ],
                    }

                    controller.enqueue(
                      encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
                    )
                  }

                  // Handle function calls
                  if (part.functionCall) {
                    const chunk = {
                      id: requestId,
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model,
                      choices: [
                        {
                          index: 0,
                          delta: {
                            tool_calls: [
                              {
                                index: 0,
                                id: `call_${Date.now()}`,
                                type: "function",
                                function: {
                                  name: part.functionCall.name,
                                  arguments: JSON.stringify(
                                    part.functionCall.args,
                                  ),
                                },
                              },
                            ],
                          },
                          finish_reason: null,
                        },
                      ],
                    }

                    controller.enqueue(
                      encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
                    )
                  }
                }
              } catch {
                // Skip invalid JSON
              }
            }
          }
        }
      } catch (error) {
        consola.error("Stream transform error:", error)
        controller.error(error)
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}

/**
 * Transform Antigravity non-stream response to OpenAI format
 */
async function transformNonStreamResponse(
  response: Response,
  model: string,
): Promise<Response> {
  const data = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string
          thought?: boolean
          functionCall?: { name: string; args: unknown }
        }>
      }
      finishReason?: string
    }>
    usageMetadata?: {
      promptTokenCount?: number
      candidatesTokenCount?: number
      totalTokenCount?: number
    }
  }

  const candidate = data.candidates?.[0]
  const parts = candidate?.content?.parts || []

  let content = ""
  let reasoningContent = ""
  const toolCalls: Array<unknown> = []

  for (const part of parts) {
    if (part.thought && part.text) {
      reasoningContent += part.text
    } else if (part.text) {
      content += part.text
    }

    if (part.functionCall) {
      toolCalls.push({
        id: `call_${Date.now()}`,
        type: "function",
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args),
        },
      })
    }
  }

  const message: Record<string, unknown> = {
    role: "assistant",
    content: content || null,
  }

  if (reasoningContent) {
    message.reasoning_content = reasoningContent
  }

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls
  }

  const openaiResponse = {
    id: `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: candidate?.finishReason === "STOP" ? "stop" : "stop",
      },
    ],
    usage: {
      prompt_tokens: data.usageMetadata?.promptTokenCount || 0,
      completion_tokens: data.usageMetadata?.candidatesTokenCount || 0,
      total_tokens: data.usageMetadata?.totalTokenCount || 0,
    },
  }

  return new Response(JSON.stringify(openaiResponse), {
    headers: { "Content-Type": "application/json" },
  })
}
