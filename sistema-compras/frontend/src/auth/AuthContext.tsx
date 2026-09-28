import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, aoExpirarSessao, token } from '../api/client';
import type { UsuarioSessao } from '../api/tipos';

interface Sessao {
  usuario: UsuarioSessao | null;
  carregando: boolean;
  entrar: (email: string, senha: string) => Promise<void>;
  sair: () => void;
  pode: (permissao: string) => boolean;
}

const Contexto = createContext<Sessao | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [usuario, setUsuario] = useState<UsuarioSessao | null>(null);
  const [carregando, setCarregando] = useState(true);

  const sair = useCallback(() => {
    token.limpar();
    setUsuario(null);
  }, []);

  // Restaura a sessao a partir do token guardado; a API revalida o usuario
  // a cada request, entao um usuario desativado cai aqui imediatamente.
  useEffect(() => {
    const jwt = token.ler();
    if (!jwt) {
      setCarregando(false);
      return;
    }
    api<UsuarioSessao>('/auth/eu')
      .then(({ data }) => setUsuario(data))
      .catch(() => token.limpar())
      .finally(() => setCarregando(false));
  }, []);

  useEffect(() => aoExpirarSessao(() => setUsuario(null)), []);

  const entrar = useCallback(async (email: string, senha: string) => {
    const { data } = await api<{ token: string; usuario: UsuarioSessao }>('/auth/login', {
      metodo: 'POST',
      corpo: { email, senha },
      semAutenticacao: true,
    });
    token.gravar(data.token);
    setUsuario(data.usuario);
  }, []);

  const valor = useMemo<Sessao>(
    () => ({
      usuario,
      carregando,
      entrar,
      sair,
      // A interface esconde o que o usuario nao pode fazer, mas quem decide
      // de verdade e o backend: isso aqui e so conveniencia visual.
      pode: (permissao: string) => Boolean(usuario?.permissoes?.includes(permissao)),
    }),
    [usuario, carregando, entrar, sair],
  );

  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}

export function useAuth() {
  const contexto = useContext(Contexto);
  if (!contexto) throw new Error('useAuth precisa estar dentro de AuthProvider');
  return contexto;
}
