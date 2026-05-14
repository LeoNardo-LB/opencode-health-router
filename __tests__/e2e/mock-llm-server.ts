import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"

export interface MockResponse {
  status?: number
  body?: string
  headers?: Record<string, string>
}

export interface CallLog {
  method: string
  url: string
  body?: string
  responseStatus: number
  timestamp: number
}

/**
 * Programmable Mock LLM Server simulating OpenAI-compatible API.
 *
 * Usage:
 *   const server = new MockLLMServer()
 *   server.replyText("Hello!")          // 200 with text
 *   server.replyRateLimit()             // 429 rate limit
 *   server.replyText("Fallback OK")    // 200 with text
 *   await server.start(9876)
 *   // ... tests ...
 *   await server.stop()
 */
export class MockLLMServer {
  private server: Server | null = null
  private queue: MockResponse[] = []
  private callLog: CallLog[] = []
  private defaultResponse: MockResponse = {
    status: 200,
    body: '{"id":"default","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"default"},"finish_reason":"stop"}]}',
  }

  /** Queue a custom response */
  respondWith(response: MockResponse): this {
    this.queue.push(response)
    return this
  }

  /** Queue a standard OpenAI-format text reply */
  replyText(text: string): this {
    return this.respondWith({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    })
  }

  /** Queue N identical responses */
  replyTextN(text: string, count: number): this {
    for (let i = 0; i < count; i++) this.replyText(text)
    return this
  }

  /** Queue a 429 Rate Limit error */
  replyRateLimit(message = "429 已达到 5 小时的使用上限"): this {
    return this.respondWith({
      status: 429,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: { message, type: "rate_limit_error", code: 429 },
      }),
    })
  }

  /** Queue N consecutive 429 errors */
  replyRateLimitN(count: number, message = "429 已达到 5 小时的使用上限"): this {
    for (let i = 0; i < count; i++) this.replyRateLimit(message)
    return this
  }

  /** Queue a 500 Server Error */
  replyServerError(message = "500 Internal Server Error"): this {
    return this.respondWith({
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: { message, type: "server_error", code: 500 },
      }),
    })
  }

  /** Queue a 402 Payment Required / quota exceeded error */
  replyQuotaExceeded(message = "402 Insufficient quota. Please check your plan and billing details."): this {
    return this.respondWith({
      status: 402,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: { message, type: "insufficient_quota", code: 402 },
      }),
    })
  }

  /** Queue a 529 Overloaded error */
  replyOverloaded(message = "529 The model is overloaded. Please try again later."): this {
    return this.respondWith({
      status: 529,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: { message, type: "overloaded", code: 529 },
      }),
    })
  }

  /** Queue N consecutive overloaded errors */
  replyOverloadedN(count: number, message = "529 The model is overloaded. Please try again later."): this {
    for (let i = 0; i < count; i++) this.replyOverloaded(message)
    return this
  }

  /** Queue a response with an arbitrary status code */
  replyStatus(status: number, message: string): this {
    return this.respondWith({
      status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: { message, type: "error", code: status },
      }),
    })
  }

  /** Queue a timeout (delayed response) */
  replyTimeout(delayMs: number): this {
    return this.respondWith({
      status: 200,
      body: JSON.stringify({ error: { message: `request timed out after ${delayMs}ms`, type: "timeout" } }),
    })
  }

  /** Get call log */
  getCallLog(): CallLog[] {
    return [...this.callLog]
  }
  getCallCount(): number {
    return this.callLog.length
  }
  getLastCall(): CallLog | undefined {
    return this.callLog[this.callLog.length - 1]
  }

  /** Reset call log (keep response queue) */
  resetCallLog(): void {
    this.callLog = []
  }

  /** Set default response when queue is empty */
  setDefault(response: MockResponse): this {
    this.defaultResponse = response
    return this
  }

  /** Start the server */
  async start(port: number, hostname = "127.0.0.1"): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        let body = ""
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString()
        })
        req.on("end", () => {
          const response = this.queue.shift() ?? this.defaultResponse
          const status = response.status ?? 200
          const headers = response.headers ?? { "Content-Type": "application/json" }

          res.writeHead(status, headers)
          res.end(response.body ?? "")

          this.callLog.push({
            method: req.method ?? "GET",
            url: req.url ?? "/",
            body: body ? body.slice(0, 1000) : undefined,
            responseStatus: status,
            timestamp: Date.now(),
          })
        })
      })
      this.server.on("error", reject)
      this.server.listen(port, hostname, () => resolve())
    })
  }

  /** Stop the server */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null
          resolve()
        })
      } else {
        resolve()
      }
    })
  }
}
