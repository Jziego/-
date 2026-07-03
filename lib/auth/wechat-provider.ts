import type { OAuthConfig, OAuthUserConfig } from "@auth/core/providers/oauth";

interface WeChatProfile {
  unionid: string;
  openid: string;
  nickname: string;
  headimgurl: string;
  sex?: number;
  province?: string;
  city?: string;
}

/**
 * NextAuth v5 custom OAuth provider for WeChat Open Platform (微信开放平台).
 *
 * Prerequisites:
 * - Enterprise certification on open.weixin.qq.com
 * - AppID and AppSecret from WeChat Open Platform
 * - Callback URL whitelisted: https://your-domain/api/auth/callback/wechat
 *
 * Docs: https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html
 */
/** Fetch with a configurable timeout (default 10s). */
async function fetchWithTimeout(
  url: string,
  timeoutMs = 10_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function WeChatProvider<P extends WeChatProfile>(
  config: OAuthUserConfig<P>,
): OAuthConfig<P> {
  // Use config values populated by auth.ts (via lib/env.ts helpers).
  // Never read process.env directly — keep a single source of truth for env access.
  return {
    id: "wechat",
    name: "微信",
    type: "oauth",
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    authorization: {
      url: "https://open.weixin.qq.com/connect/qrconnect",
      params: {
        appid: config.clientId,
        response_type: "code",
        scope: "snsapi_login",
      },
    },
    token: {
      url: "https://api.weixin.qq.com/sns/oauth2/access_token",
      async request(context: { params: Record<string, unknown>; provider: { clientId?: string; clientSecret?: string; token?: { url?: string } } }) {
        const { params, provider } = context;
        const url = new URL(provider.token!.url!);
        url.searchParams.set("appid", provider.clientId!);
        url.searchParams.set("secret", provider.clientSecret!);
        url.searchParams.set("code", params.code as string);
        url.searchParams.set("grant_type", "authorization_code");

        const res = await fetchWithTimeout(url.toString());
        const json = await res.json() as Record<string, unknown>;

        if (json.errcode && (json.errcode as number) !== 0) {
          throw new Error(`WeChat token error [${json.errcode}]: ${json.errmsg}`);
        }

        return { tokens: json as Record<string, unknown> };
      },
    },
    userinfo: {
      url: "https://api.weixin.qq.com/sns/userinfo",
      async request(context: { tokens: Record<string, unknown>; provider: { userinfo?: { url?: string } } }) {
        const { tokens, provider } = context;
        const url = new URL(provider.userinfo!.url!);
        url.searchParams.set("access_token", tokens.access_token as string);
        url.searchParams.set("openid", tokens.openid as string);

        const res = await fetchWithTimeout(url.toString());
        const json = await res.json() as Record<string, unknown>;

        if (json.errcode && (json.errcode as number) !== 0) {
          throw new Error(`WeChat userinfo error [${json.errcode}]: ${json.errmsg}`);
        }

        return json as unknown as WeChatProfile;
      },
    },
    profile(profile: WeChatProfile) {
      return {
        id: profile.unionid || profile.openid,
        name: profile.nickname || "微信用户",
        image: profile.headimgurl || null,
        email: null, // WeChat does not provide email in snsapi_login scope
      };
    },
    style: {
      logo: "/wechat-logo.svg",
      bg: "#07C160",
      text: "#fff",
    },
  };
}
