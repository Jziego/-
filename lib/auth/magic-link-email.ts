/**
 * Render the magic-link sign-in email body.
 *
 * Email clients vary widely: some block `<a>` clicks, some strip the href
 * attribute entirely. We render BOTH a clickable button AND the raw URL as
 * copyable fallback text, so the user can always reach the link.
 */
export function renderMagicLinkEmail(url: string): string {
  return [
    `<p>点击下方按钮登录 AI 短视频助手：</p>`,
    `<p><a href="${url}">登录</a></p>`,
    `<p>若上方按钮无法点击，请复制以下链接到浏览器地址栏打开：</p>`,
    `<p>${url}</p>`,
    `<p>链接 24 小时内有效。</p>`,
  ].join("");
}
