export async function safeJsonParse<T>(response: Response, context: string): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(
      `${context}: expected JSON but received unparseable body (HTTP ${String(response.status)})`
    );
  }
}
