/** A model-list request verifies credentials without issuing a generation. */
export async function verifyDshKey(key: string, request: typeof fetch = fetch): Promise<{ authenticated: boolean; error?: string }> {
  try {
    const response = await request("https://api.deepseek.com/models", {
      headers: { "x-api-key": key, accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) return { authenticated: false, error: "API Key 无效或无权访问，请重新配置" };
    if (!response.ok) return { authenticated: false, error: `无法验证 API Key（HTTP ${response.status}），请稍后重试` };
    const body = await response.json().catch(() => null) as { data?: unknown } | null;
    if (!Array.isArray(body?.data) || !body.data.some((item: unknown) => item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" && (item as { id: string }).id.trim())) {
      return { authenticated: false, error: "无法验证 API Key：模型列表响应无效" };
    }
    return { authenticated: true };
  } catch {
    return { authenticated: false, error: "无法连接 DeepSeek，暂时无法验证 API Key" };
  }
}
