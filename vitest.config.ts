import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    server: {
      deps: {
        // Inline next-auth so Vite processes its code and resolves "next/server"
        // via the alias below (Node.js ESM cannot resolve next/server directly
        // because next/package.json lacks an exports field for "./server").
        inline: ["next-auth", "@auth/core"],
      },
    },
  },
  resolve: {
    alias: {
      "@": new URL(".", import.meta.url).pathname,
      // next-auth imports from "next/server" but next/package.json does not
      // declare an "exports" field for "./server". Vite/Vitest needs an
      // explicit alias to resolve the CJS module at next/server.js.
      "next/server": new URL("node_modules/next/server.js", import.meta.url)
        .pathname,
      // nodemailer is imported by @auth/core but never called at runtime
      // (auth.ts overrides sendVerificationRequest with Resend).
      // Webpack config aliases it to false; Vitest uses an empty stub.
      nodemailer: new URL("tests/__mocks__/nodemailer.ts", import.meta.url)
        .pathname,
      // @auth/core providers that require nodemailer — redirect to the same stub
      // because @auth/core is externalized (in node_modules) so the nodemailer
      // alias above is not applied to its imports.
      "@auth/core/providers/nodemailer": new URL(
        "tests/__mocks__/nodemailer.ts",
        import.meta.url,
      ).pathname,
    }
  }
});
