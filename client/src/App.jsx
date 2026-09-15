import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { FullPageSpinner } from './components/FullPageSpinner';
import { ProtectedRoute, PublicOnlyRoute } from './components/ProtectedRoute';
import { AuthProvider } from './context/AuthProvider';
import { useAuth } from './context/auth-context';
import { hasSessionHint } from './lib/session';
import { DashboardPage } from './pages/DashboardPage';
import { LandingPage } from './pages/LandingPage';
import { LoginPage } from './pages/LoginPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { RegisterPage } from './pages/RegisterPage';
import { SettingsPage } from './pages/SettingsPage';

/**
 * `/` means two different things depending on who is asking.
 *
 * A signed-in user going to the root wants their vault -- it is a bookmarking
 * app, and that is the page they keep open. A stranger wants to know what this
 * is before being asked for an account, which is what `ProtectedRoute` used to
 * deny them: it bounced every signed-out visitor straight to a bare login form
 * with no explanation of the product attached.
 *
 * Resolving it here rather than by giving the dashboard its own path keeps the
 * URL people bookmark as `/`, and keeps `PublicOnlyRoute`'s redirect target
 * correct without it having to know anything new.
 *
 * **Why the session hint is consulted before `isLoading`.** The API runs on an
 * instance that sleeps, and waking it has been measured at 23 seconds. Waiting
 * on the session check would mean a first-time visitor watches a spinner for
 * that long before being told what the product is -- which is precisely the
 * first impression this page was added to prevent, and it lands hardest on
 * someone in a timezone where the keep-warm ping is not running. A browser that
 * has never held a session has nothing to wait for, so it gets the pitch
 * immediately and the check finishes underneath it.
 */
function HomeRoute() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    // A returning user does get the spinner, and should: they asked for their
    // vault, and flashing a marketing page at them on the way would be worse
    // than a moment of waiting.
    return hasSessionHint() ? <FullPageSpinner /> : <LandingPage />;
  }

  return user ? <DashboardPage /> : <LandingPage />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<HomeRoute />} />

          <Route element={<PublicOnlyRoute />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
          </Route>

          <Route element={<ProtectedRoute />}>
            <Route path="/settings" element={<SettingsPage />} />
          </Route>

          {/*
            Outside both gates, deliberately. A Chrome Web Store reviewer reads
            this without an account, and `PublicOnlyRoute` would bounce a signed-in
            user away from their own policy.
          */}
          <Route path="/privacy" element={<PrivacyPage />} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
