import { Suspense } from "react";
import { AuthForm } from "../AuthForm";

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="card p-6 text-center text-sm text-slate-500">Loading…</div>}>
      <AuthForm mode="login" />
    </Suspense>
  );
}