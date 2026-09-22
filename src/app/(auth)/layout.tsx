export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-gradient-to-br from-indigo-950 via-slate-900 to-slate-950 p-4">
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}