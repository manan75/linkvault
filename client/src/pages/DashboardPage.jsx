import { useAuth } from '../context/auth-context';

export function DashboardPage() {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4">
          <span className="text-lg font-semibold tracking-tight">LinkVault</span>
          <div className="flex items-center gap-4">
            <span className="text-sm text-slate-600">{user.email}</span>
            <button
              type="button"
              onClick={logout}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium transition hover:bg-slate-100"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-12">
        <h1 className="text-2xl font-semibold tracking-tight">Hi {user.name.split(' ')[0]}</h1>
        <p className="mt-2 text-slate-600">
          Your vault is empty. Saving and searching links arrives in the next phase.
        </p>
      </main>
    </div>
  );
}
