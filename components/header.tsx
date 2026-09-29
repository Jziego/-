"use client";

import { useEffect, useState, useTransition } from "react";
import { signOutWithRevocation } from "@/app/login/actions";
import { fetchPoints, notifyPointsChanged, redeemPointsApi } from "@/lib/api-client";

type HeaderProps = {
  /** Signed-in user's email. When null, the account/logout UI is hidden. */
  email: string | null;
};

/**
 * App header shown on authenticated pages. Renders the signed-in user's
 * email and a logout button that revokes the JWT (via signOutWithRevocation)
 * rather than just clearing the cookie.
 */
export function Header({ email }: HeaderProps) {
  const [isPending, startTransition] = useTransition();

  return (
    <header className="appHeader">
      <div className="appHeader__brand">AI 短视频助手</div>
      {email ? (
        <div className="appHeader__account">
          <PointsBalance />
          <span className="appHeader__email">{email}</span>
          <button
            type="button"
            className="appHeader__signout"
            disabled={isPending}
            onClick={() => {
              startTransition(async () => {
                await signOutWithRevocation();
              });
            }}
          >
            {isPending ? "退出中…" : "退出登录"}
          </button>
        </div>
      ) : null}
    </header>
  );
}

/**
 * 积分余额 + 兑换入口。挂载时拉一次余额；监听 ava:points-changed 事件
 * （dashboard 扣费动作后派发）自动刷新。无数据库（balance=null）显示「—」。
 */
function PointsBalance() {
  const [balance, setBalance] = useState<number | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const b = await fetchPoints();
        if (!cancelled) {
          setBalance(b);
          setLoadFailed(false);
        }
      } catch {
        if (!cancelled) {
          setBalance(null);
          setLoadFailed(true);
        }
      }
    };
    void refresh();
    window.addEventListener("ava:points-changed", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("ava:points-changed", refresh);
    };
  }, []);

  async function handleRedeem() {
    if (!code.trim() || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await redeemPointsApi(code.trim());
      setBalance(result.balance);
      // 派发刷新事件，让同页面其他积分消费方（dashboard 等）同步收敛，
      // 避免各自在途刷新之间的竞态。
      notifyPointsChanged();
      setNotice(`兑换成功：+${result.points} 积分`);
      setCode("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "兑换失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="appHeader__pointsWrap">
      <span className="appHeader__points" aria-label="积分余额">
        积分 {loadFailed ? "?" : (balance ?? "—")}
      </span>
      <button
        type="button"
        className="appHeader__redeem"
        onClick={() => {
          setDialogOpen(true);
          setNotice(null);
        }}
      >
        兑换
      </button>

      {dialogOpen ? (
        <div
          className="redeemDialog"
          role="dialog"
          aria-label="兑换积分"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape") setDialogOpen(false);
          }}
        >
          <label>
            兑换码
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="XXXX-XXXX-XXXX-XXXX"
              autoFocus
            />
          </label>
          {notice ? <p role="status">{notice}</p> : null}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="primaryButton"
              disabled={busy || !code.trim()}
              onClick={() => void handleRedeem()}
            >
              {busy ? "兑换中…" : "确认兑换"}
            </button>
            <button
              type="button"
              className="secondaryButton"
              onClick={() => setDialogOpen(false)}
            >
              关闭
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
