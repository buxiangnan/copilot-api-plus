/**
 * Google Antigravity Messages API
 *
 * Converts Anthropic Messages API format to Antigravity format.
 * This enables Claude Code to use Antigravity as backend.
 *
 * Based on: https://github.com/liuw1535/antigravity2api-nodejs
 */

import consola from "consola"

import { disableCurrentAccount, getValidAccessToken, rotateAccount } from "./auth"
import { isThinkingModel } from "./get-models"

// Antigravity API endpoints
const ANTIGRAVITY_API_HOST = "daily-cloudcode-pa.sandbox.googleapis.com"
const ANTIGRAVITY_STREAM_URL = `https://${ANTIGRAVITY_API_HOST}/v1internal:streamGenerateContent?alt=sse`
const ANTIGRAVITY_NO_STREAM_URL = `https://${ANTIGRAVITY_API_HOST}/v1internal:generateContent`
const ANTIGRAVITY_USER_AGENT = "antigravity/1.11.3 windows/amd64"

export interface AnthropicMessage {
  role: "user" | "assistant"
  content:
    | string
    | Array<{
        type: string
        text?: string
        source?: { type: string; media_type: string; data: string }
      }>
}

export interface AnthropicMessageRequest {
  model: string
  messages: AnthropicMessage[]
  system?: string
  max_tokens: number
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  tools?: unknown[]
}

/**
 * Convert Anthropic messages to Antigravity format
 */
function convertMessages(
  messages: AnthropicMessage[],
  system?: string,
): { contents: unknown[]; systemInstruction?: unknown } {
  const contents: unknown[] = []
  let systemInstruction: unknown = undefined

  // Handle system message
  if (system) {
    systemInstruction = {
      role: "user",
      parts: [{ text: system }],
    }
  }

  for (const message of messages) {
    const role = message.role === "assistant" ? "model" : "user"

    if (typeof message.content === "string") {
      contents.push({
        role,
        parts: [{ text: message.content }],
      })
    } else {
      // Handle array content (multimodal)
      const parts: unknown[] = []

      for (const block of message.content) {
        if (block.type === "text" && block.text) {
          parts.push({ text: block.text })
        } else if (block.type === "image" && block.source) {
          // Handle base64 image
          parts.push({
            inlineData: {
              mimeType: block.source.media_type,
              data: block.source.data,
            },
          })
        }
      }

      if (parts.length > 0) {
        contents.push({ role, parts })
      }
    }
  }

  return { contents, systemInstruction }
}

/**
 * Convert tools to Antigravity format
 */
function convertTools(tools?: unknown[]): unknown[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined
  }

  return tools.map((tool: unknown) => {
    const t = tool as {
      name: string
      description?: string
      input_schema?: unknown
    }
    return {
      functionDeclarations: [
        {
          name: t.name,
          description: t.description || "",
          parameters: t.input_schema || {},
        },
      ],
    }
  })
}

/**
 * Create Anthropic-compatible message response using Antigravity
 */
export async function createAntigravityMessages(
  request: AnthropicMessageRequest,
): Promise<Response> {
  const accessToken = await getValidAccessToken()

  if (!accessToken) {
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "authentication_error",
          message:
            "No valid Antigravity access token available. Please run login first.",
        },
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    )
  }

  const { contents, systemInstruction } = convertMessages(
    request.messages,
    request.system,
  )
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

  const endpoint = request.stream
    ? ANTIGRAVITY_STREAM_URL
    : ANTIGRAVITY_NO_STREAM_URL

  consola.debug(
    `Antigravity messages request to ${endpoint} with model ${request.model}`,
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
          type: "error",
          error: {
            type: "api_error",
            message: `Antigravity API error: ${response.status}`,
          },
        }),
        {
          status: response.status,
          headers: { "Content-Type": "application/json" },
        },
      )
    }

    if (request.stream) {
      // Transform SSE stream to Anthropic format
      return transformStreamToAnthropic(response, request.model)
    } else {
      // Transform non-stream response to Anthropic format
      return transformNonStreamToAnthropic(response, request.model)
    }
  } catch (error) {
    consola.error("Antigravity messages request error:", error)
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "api_error",
          message: `Request failed: ${error}`,
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
 * Transform Antigravity stream response to Anthropic format
 */
function transformStreamToAnthropic(
  response: Response,
  model: string,
): Response {
  const reader = response.body?.getReader()

  if (!reader) {
    return new Response("No response body", { status: 500 })
  }

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const stream = new ReadableStream({
    async start(controller) {
      let buffer = ""
      const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
      let inputTokens = 0
      let outputTokens = 0
      let contentBlockIndex = 0
      let thinkingBlockStarted = false
      let textBlockStarted = false

      // Send message_start event
      const messageStart = {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        },
      }
      controller.enqueue(
        encoder.encode(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`),
      )

      try {
        while (true) {
          const { done, value } = await reader.read()

          if (done) {
            // Send message_stop event
            const messageStop = { type: "message_stop" }
            controller.enqueue(
              encoder.encode(`event: message_stop\ndata: ${JSON.stringify(messageStop)}\n\n`),
            )
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
                    usageMetadata?: {
                      promptTokenCount?: number
                      candidatesTokenCount?: number
                    }
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
                  usageMetadata?: {
                    promptTokenCount?: number
                    candidatesTokenCount?: number
                  }
                }

                // Handle both response wrapper and direct candidates
                const candidates =
                  parsed.response?.candidates || parsed.candidates
                const candidate = candidates?.[0]
                const parts = candidate?.content?.parts || []
                const usage =
                  parsed.response?.usageMetadata || parsed.usageMetadata

                if (usage) {
                  inputTokens = usage.promptTokenCount || inputTokens
                  outputTokens = usage.candidatesTokenCount || outputTokens
                }

                for (const part of parts) {
                  // Handle thinking content
                  if (part.thought && part.text) {
                    if (!thinkingBlockStarted) {
                      // Start thinking block
                      const blockStart = {
                        type: "content_block_start",
                        index: contentBlockIndex,
                        content_block: {
                          type: "thinking",
                          thinking: "",
                        },
                      }
                      controller.enqueue(
                        encoder.encode(
                          `event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`,
                        ),
                      )
                      thinkingBlockStarted = true
                    }

                    // Send thinking delta
                    const thinkingDelta = {
                      type: "content_block_delta",
                      index: contentBlockIndex,
                      delta: {
                        type: "thinking_delta",
                        thinking: part.text,
                      },
                    }
                    controller.enqueue(
                      encoder.encode(
                        `event: content_block_delta\ndata: ${JSON.stringify(thinkingDelta)}\n\n`,
                      ),
                    )
                    continue
                  }

                  // Handle regular text content
                  if (part.text && !part.thought) {
                    // Close thinking block if open
                    if (thinkingBlockStarted && !textBlockStarted) {
                      const blockStop = {
                        type: "content_block_stop",
                        index: contentBlockIndex,
                      }
                      controller.enqueue(
                        encoder.encode(
                          `event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`,
                        ),
                      )
                      contentBlockIndex++
                    }

                    // Start text block if not started
                    if (!textBlockStarted) {
                      const blockStart = {
                        type: "content_block_start",
                        index: contentBlockIndex,
                        content_block: {
                          type: "text",
                          text: "",
                        },
                      }
                      controller.enqueue(
                        encoder.encode(
                          `event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`,
                        ),
                      )
                      textBlockStarted = true
                    }

                    // Send text delta
                    const textDelta = {
                      type: "content_block_delta",
                      index: contentBlockIndex,
                      delta: {
                        type: "text_delta",
                        text: part.text,
                      },
                    }
                    controller.enqueue(
                      encoder.encode(
                        `event: content_block_delta\ndata: ${JSON.stringify(textDelta)}\n\n`,
                      ),
                    )
                  }

                  // Handle function calls
                  if (part.functionCall) {
                    // Close previous block if open
                    if (textBlockStarted || thinkingBlockStarted) {
                      const blockStop = {
                        type: "content_block_stop",
                        index: contentBlockIndex,
                      }
                      controller.enqueue(
                        encoder.encode(
                          `event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`,
                        ),
                      )
                      contentBlockIndex++
                      textBlockStarted = false
                      thinkingBlockStarted = false
                    }

                    // Send tool use block
                    const toolBlockStart = {
                      type: "content_block_start",
                      index: contentBlockIndex,
                      content_block: {
                        type: "tool_use",
                        id: `toolu_${Date.now()}`,
                        name: part.functionCall.name,
                        input: {},
                      },
                    }
                    controller.enqueue(
                      encoder.encode(
                        `event: content_block_start\ndata: ${JSON.stringify(toolBlockStart)}\n\n`,
                      ),
                    )

                    // Send tool input delta
                    const toolDelta = {
                      type: "content_block_delta",
                      index: contentBlockIndex,
                      delta: {
                        type: "input_json_delta",
                        partial_json: JSON.stringify(part.functionCall.args),
                      },
                    }
                    controller.enqueue(
                      encoder.encode(
                        `event: content_block_delta\ndata: ${JSON.stringify(toolDelta)}\n\n`,
                      ),
                    )

                    // Close tool block
                    const toolBlockStop = {
                      type: "content_block_stop",
                      index: contentBlockIndex,
                    }
                    controller.enqueue(
                      encoder.encode(
                        `event: content_block_stop\ndata: ${JSON.stringify(toolBlockStop)}\n\n`,
                      ),
                    )
                    contentBlockIndex++
                  }
                }

                // Handle finish reason
                if (candidate?.finishReason === "STOP") {
                  // Close any open blocks
                  if (textBlockStarted || thinkingBlockStarted) {
                    const blockStop = {
                      type: "content_block_stop",
                      index: contentBlockIndex,
                    }
                    controller.enqueue(
                      encoder.encode(
                        `event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`,
                      ),
                    )
                  }

                  // Send message_delta with stop reason
                  const messageDelta = {
                    type: "message_delta",
                    delta: {
                      stop_reason: "end_turn",
                      stop_sequence: null,
                    },
                    usage: {
                      output_tokens: outputTokens,
                    },
                  }
                  controller.enqueue(
                    encoder.encode(
                      `event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`,
                    ),
                  )
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
 * Transform Antigravity non-stream response to Anthropic format
 */
async function transformNonStreamToAnthropic(
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

  const content: Array<{
    type: string
    text?: string
    thinking?: string
    id?: string
    name?: string
    input?: unknown
  }> = []

  for (const part of parts) {
    if (part.thought && part.text) {
      content.push({
        type: "thinking",
        thinking: part.text,
      })
    } else if (part.text) {
      content.push({
        type: "text",
        text: part.text,
      })
    }

    if (part.functionCall) {
      content.push({
        type: "tool_use",
        id: `toolu_${Date.now()}`,
        name: part.functionCall.name,
        input: part.functionCall.args,
      })
    }
  }

  const anthropicResponse = {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: candidate?.finishReason === "STOP" ? "end_turn" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: data.usageMetadata?.promptTokenCount || 0,
      output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
    },
  }

  return new Response(JSON.stringify(anthropicResponse), {
    headers: { "Content-Type": "application/json" },
  })
}
