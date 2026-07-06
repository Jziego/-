"use client";

import { useTransition } from "react";
import { signOutWithRevocation } from "@/app/login/actions";

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
