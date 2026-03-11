export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  return (await response.json()) as T
}

export async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return (await response.json()) as T
}
