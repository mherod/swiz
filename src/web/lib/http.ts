const MAX_ATTEMPTS = 3
const REQUEST_TIMEOUT_MS = 5000
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])

class JsonRequestError extends Error {
  retryable: boolean
  status: number | null

  constructor(message: string, options?: { retryable?: boolean; status?: number | null }) {
    super(message)
    this.name = "JsonRequestError"
    this.retryable = options?.retryable ?? true
    this.status = options?.status ?? null
  }
}

function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", abort, { once: true })
  })
}

function retryDelayMs(attempt: number): number {
  const base = 350
  return base * 2 ** attempt
}

function bodyPreview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 120)
}

function looksLikeHtml(text: string): boolean {
  return /^\s*<(?:!doctype|html|head|body|div|script)\b/i.test(text)
}

async function parseJsonResponse<T>(response: Response, url: string): Promise<T> {
  const rawBody = await response.text()
  const preview = bodyPreview(rawBody)

  if (!response.ok) {
    if (looksLikeHtml(rawBody)) {
      throw new JsonRequestError(
        `Request to ${url} failed with ${response.status} ${response.statusText} (received HTML error page)`,
        {
          retryable: RETRYABLE_HTTP_STATUSES.has(response.status),
          status: response.status,
        }
      )
    }
    const suffix = preview ? `: ${preview}` : ""
    throw new JsonRequestError(
      `Request to ${url} failed with ${response.status} ${response.statusText}${suffix}`,
      {
        retryable: RETRYABLE_HTTP_STATUSES.has(response.status),
        status: response.status,
      }
    )
  }

  if (!rawBody.trim()) {
    throw new JsonRequestError(`Request to ${url} returned an empty response body`)
  }

  try {
    return JSON.parse(rawBody) as T
  } catch {
    if (looksLikeHtml(rawBody)) {
      throw new JsonRequestError(
        `Request to ${url} returned HTML instead of JSON. Make sure the dashboard API endpoint is reachable.`
      )
    }
    throw new JsonRequestError(
      `Request to ${url} returned invalid JSON${preview ? `: ${preview}` : ""}`
    )
  }
}

async function requestAttempt<T>(url: string, init?: RequestInit): Promise<T> {
  init?.signal?.throwIfAborted()
  const response = await fetch(url, {
    ...init,
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const data = await parseJsonResponse<T>(response, url)
  init?.signal?.throwIfAborted()
  return data
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await requestAttempt<T>(url, init)
    } catch (error) {
      init?.signal?.throwIfAborted()
      lastError = error
      const isRetryable =
        error instanceof JsonRequestError ? error.retryable : error instanceof Error
      const isLastAttempt = attempt === MAX_ATTEMPTS - 1
      if (isLastAttempt || !isRetryable) {
        throw error
      }
      await delay(retryDelayMs(attempt), init?.signal)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return requestJson<T>(url, { signal })
}

export async function postJson<T>(
  url: string,
  body: Record<string, any>,
  signal?: AbortSignal
): Promise<T> {
  return requestJson<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  })
}
