import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './AuthContext';

export function RotaProtegida({ children }: { children: ReactNode }) {
  const { usuario, carregando } = useAuth();
  const local = useLocation();

  if (carregando) return <div className="carregando">Carregando sessao…</div>;
  if (!usuario) return <Navigate to="/login" state={{ de: local.pathname }} replace />;
  return <>{children}</>;
}
