"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Give the client a short staleTime so data fetched during SSR
            // isn't immediately invalidated on hydration.
            staleTime: 30 * 1000
          }
        }
      })
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
