/**
 * <altcha-widget> custom element 的 React JSX 类型声明。
 *
 * altcha 包自带的 dist/types/react.d.ts 只声明了 challenge 等属性，
 * 没有 onstatechange 事件入口（官方示例走 addEventListener），这里自行声明。
 * 注意 v3 的属性名是 challenge（可直接传挑战 URL），不是 v1/v2 的 challengeurl。
 */

/** statechange 事件的 detail 载荷；仅 verified 态保证携带 payload。 */
export interface AltchaStateChangeDetail {
  state: string;
  payload?: string;
}

type AltchaWidgetElement = React.DetailedHTMLProps<
  React.HTMLAttributes<HTMLElement> & {
    /** 挑战来源：Challenge JSON 字符串或挑战签发 URL（本项目传 URL）。 */
    challenge?: string;
    /** unknown 收窄交给 handler 内的运行时守卫，不信任事件载荷类型。 */
    onstatechange?: (event: unknown) => void;
  },
  HTMLElement
>;

declare global {
  namespace React {
    namespace JSX {
      interface IntrinsicElements {
        "altcha-widget": AltchaWidgetElement;
      }
    }
  }
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "altcha-widget": AltchaWidgetElement;
    }
  }
}

declare module "react/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements {
      "altcha-widget": AltchaWidgetElement;
    }
  }
}

export {};
