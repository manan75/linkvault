import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { useAuth } from '../context/auth-context';
import { FullPageSpinner } from './FullPageSpinner';

/** Gate for routes that require a signed-in user. */
export function ProtectedRoute() {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return <FullPageSpinner />;

  // `state` lets the login page send the user back where they were headed.
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;

  return <Outlet />;
}

/** Gate for pages that only make sense when signed out (login, register). */
export function PublicOnlyRoute() {
  const { user, isLoading } = useAuth();

  if (isLoading) return <FullPageSpinner />;
  if (user) return <Navigate to="/" replace />;

  return <Outlet />;
}
