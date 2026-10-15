export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Zeabur（Aliyun HK）容器 IPv6 出网不通，而 Ark 的域名带 AAAA 记录
    // （api.deepseek.com 无 AAAA，故旧供应商不受影响）：Node 20 未开启 address
    // family autoselection，dns.lookup 会优先返回 IPv6 导致 connect 失败
    // （"Connection error."）。全局强制 IPv4 优先，IPv6 正常的环境不受影响。
    const { setDefaultResultOrder } = await import("node:dns");
    setDefaultResultOrder("ipv4first");
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}
