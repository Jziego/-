import { Dashboard } from "@/components/dashboard";
import { Header } from "@/components/header";
import { auth } from "@/auth";

export default async function Home() {
  // Middleware already guards this route; email is null only in demo mode or
  // when the session is somehow absent — in both cases we hide the header.
  const session = await auth();
  const email = session?.user?.email ?? null;

  return (
    <>
      {email ? <Header email={email} /> : null}
      <Dashboard />
    </>
  );
}
