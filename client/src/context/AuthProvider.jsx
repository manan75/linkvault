import { useCallback, useEffect, useMemo, useState } from 'react';

import { authApi } from '../lib/api';
import { setSessionHint } from '../lib/session';
import { AuthContext } from './auth-context';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // Distinguishes "we have not checked yet" from "checked, nobody is signed in",
  // so protected routes do not redirect during the initial session lookup.
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    authApi
      .me()
      .then((data) => {
        if (cancelled) return;
        setUser(data.user);
        setSessionHint(true);
      })
      .catch((error) => {
        if (cancelled) return;
        setUser(null);
        // Only a definite "you are not signed in" clears the hint. A network
        // failure or a sleeping server proves nothing about the session, and
        // forgetting it there would send a returning user to the landing page
        // every time the API was briefly unreachable.
        if (error?.status === 401) setSessionHint(false);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const register = useCallback(async (credentials) => {
    const data = await authApi.register(credentials);
    setUser(data.user);
    setSessionHint(true);
    return data.user;
  }, []);

  const login = useCallback(async (credentials) => {
    const data = await authApi.login(credentials);
    setUser(data.user);
    setSessionHint(true);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      // The local session ends either way; a failed call must not strand the user.
      setUser(null);
      setSessionHint(false);
    }
  }, []);

  const value = useMemo(
    () => ({ user, isLoading, register, login, logout }),
    [user, isLoading, register, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
