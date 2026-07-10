"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { shouldRetryQuery } from "@/lib/query-config";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Give the client a short staleTime so data fetched during SSR
            // isn't immediately invalidated on hydration.
            staleTime: 30 * 1000,
            // Don't amplify rate-limit (429) / 4xx errors with retries, and don't
            // refetch the whole dashboard on every tab focus — both exhaust the
            // server's per-IP rate limit and trigger a 429 death-spiral.
            retry: shouldRetryQuery,
            refetchOnWindowFocus: false
          }
        }
      })
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
