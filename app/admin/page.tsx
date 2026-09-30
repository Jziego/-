"use client";

import { useEffect, useState } from "react";

const LS_KEY = "ava_admin_key";

/** 展示层格式化：每 4 字符一组用 - 连接（4×4 组约定）；长度非 4 倍数时原样返回防呆。 */
function formatCode(code: string): string {
  if (!code || code.length % 4 !== 0) return code;
  return code.match(/.{4}/g)!.join("-");
}

async function adminFetch<T>(path: string, key: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", "x-admin-key": key, ...init?.headers },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message ?? json.error ?? "请求失败");
  return json as T;
}

interface LedgerEntry {
  id: string;
  delta: number;
  reason: string;
  balanceAfter: number;
  createdAt: string;
}

export default function AdminPage() {
  const [key, setKey] = useState("");
  const [ready, setReady] = useState(false);
  // mount 后读取 localStorage，避免 SSR/水合渲染不一致（标准 hydration 门模式）
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 仅 mount 时执行一次的受控门控，非级联渲染
    setKey(window.localStorage.getItem(LS_KEY) ?? "");
    setReady(true);
  }, []);
  const [keyInput, setKeyInput] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 生成码
  const [genPoints, setGenPoints] = useState("100");
  const [genCount, setGenCount] = useState("10");
  const [codes, setCodes] = useState<string[]>([]);

  // 手动调整
  const [adjEmail, setAdjEmail] = useState("");
  const [adjDelta, setAdjDelta] = useState("500");
  const [adjNote, setAdjNote] = useState("");

  // 流水
  const [ledEmail, setLedEmail] = useState("");
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);

  if (!ready || !key) {
    return (
      <main className="authPage">
        <form
          className="authCard authForm"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = keyInput.trim();
            if (!trimmed || busy) return;
            setBusy(true);
            setNotice(null);
            void (async () => {
              try {
                // 进门即验证：只有 ping 200 才写入 localStorage 并放行工作台
                const res = await fetch("/api/admin/ping", {
                  headers: { "x-admin-key": trimmed },
                });
                if (res.ok) {
                  window.localStorage.setItem(LS_KEY, trimmed);
                  setKey(trimmed);
                  return;
                }
                setNotice(
                  res.status === 503
                    ? "后台未配置（联系部署设置 ADMIN_KEY）"
                    : "密钥错误，请重试",
                );
              } catch {
                setNotice("网络错误，请重试");
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          <h1>管理后台</h1>
          <label className="field">
            <span>管理密钥</span>
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              autoComplete="off"
            />
          </label>
          <button type="submit" className="primaryButton" disabled={busy}>进入后台</button>
          {notice ? <p role="alert">{notice}</p> : null}
        </form>
      </main>
    );
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="workspace" style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
      <h1>管理后台</h1>
      {notice ? <p role="alert">{notice}</p> : null}

      <section style={{ marginTop: 24 }}>
        <h2>生成兑换码</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <label>
            单码面值（积分）
            <input
              aria-label="单码面值（积分）"
              value={genPoints}
              onChange={(e) => setGenPoints(e.target.value)}
              inputMode="numeric"
            />
          </label>
          <label>
            生成数量
            <input
              aria-label="生成数量"
              value={genCount}
              onChange={(e) => setGenCount(e.target.value)}
              inputMode="numeric"
            />
          </label>
          <button
            type="button"
            className="primaryButton"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const data = await adminFetch<{ codes: string[] }>("/api/admin/codes", key, {
                  method: "POST",
                  body: JSON.stringify({ points: Number(genPoints), count: Number(genCount) }),
                });
                setCodes(data.codes);
              })
            }
          >
            生成
          </button>
        </div>
        {codes.length > 0 ? (
          <>
            <textarea
              readOnly
              aria-label="生成的兑换码"
              value={codes.map(formatCode).join("\n")}
              rows={Math.min(10, codes.length)}
              style={{ width: "100%", marginTop: 8 }}
            />
            <button
              type="button"
              className="secondaryButton"
              onClick={() =>
                void navigator.clipboard
                  .writeText(codes.map(formatCode).join("\n"))
                  .then(() => setNotice("已复制到剪贴板"))
                  .catch(() => setNotice("复制失败，请手动选择复制"))
              }
            >
              复制全部
            </button>
          </>
        ) : null}
      </section>

      <section style={{ marginTop: 32 }}>
        <h2>手动调整积分</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <label>
            用户邮箱
            <input value={adjEmail} onChange={(e) => setAdjEmail(e.target.value)} />
          </label>
          <label>
            变动（可为负）
            <input
              value={adjDelta}
              onChange={(e) => setAdjDelta(e.target.value)}
              inputMode="numeric"
            />
          </label>
          <label>
            备注（可选）
            <input value={adjNote} onChange={(e) => setAdjNote(e.target.value)} />
          </label>
          <button
            type="button"
            className="primaryButton"
            disabled={busy || !adjEmail.trim()}
            onClick={() =>
              void run(async () => {
                const data = await adminFetch<{ balance: number }>("/api/admin/adjust", key, {
                  method: "POST",
                  body: JSON.stringify({
                    email: adjEmail.trim(),
                    delta: Number(adjDelta),
                    note: adjNote.trim(),
                  }),
                });
                setNotice(`调整成功，当前余额 ${data.balance} 积分`);
              })
            }
          >
            提交调整
          </button>
        </div>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2>积分流水</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <label>
            用户邮箱
            <input value={ledEmail} onChange={(e) => setLedEmail(e.target.value)} />
          </label>
          <button
            type="button"
            className="primaryButton"
            disabled={busy || !ledEmail.trim()}
            onClick={() =>
              void run(async () => {
                const data = await adminFetch<{ entries: LedgerEntry[] }>(
                  `/api/admin/ledger?email=${encodeURIComponent(ledEmail.trim())}`,
                  key,
                );
                setEntries(data.entries);
              })
            }
          >
            查询
          </button>
        </div>
        {entries && entries.length > 0 ? (
          <table style={{ width: "100%", marginTop: 8 }}>
            <thead>
              <tr>
                <th>时间</th>
                <th>变动</th>
                <th>原因</th>
                <th>变动后余额</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{new Date(e.createdAt).toLocaleString()}</td>
                  <td>{e.delta > 0 ? `+${e.delta}` : e.delta}</td>
                  <td>{e.reason}</td>
                  <td>{e.balanceAfter}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : entries ? (
          <p>无记录</p>
        ) : null}
      </section>

      <section style={{ marginTop: 32 }}>
        <button
          type="button"
          className="secondaryButton"
          onClick={() => {
            window.localStorage.removeItem(LS_KEY);
            setNotice(null);
            setKey("");
          }}
        >
          清除密钥（锁定后台）
        </button>
      </section>
    </main>
  );
}
