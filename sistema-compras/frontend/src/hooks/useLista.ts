import { useCallback, useEffect, useState } from 'react';
import { api, ErroApi } from '../api/client';
import type { Meta } from '../api/tipos';

type Filtros = Record<string, string | number | boolean | undefined | null>;

/**
 * Busca paginada reutilizavel: cuida de carregamento, erro, meta de paginacao
 * e recarga. As telas so descrevem o endpoint e os filtros.
 */
export function useLista<T>(caminho: string, filtros: Filtros) {
  const [itens, setItens] = useState<T[]>([]);
  const [meta, setMeta] = useState<Meta | undefined>();
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const chave = JSON.stringify(filtros);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const { data, meta: m } = await api<T[]>(caminho, { query: JSON.parse(chave) as Filtros });
      setItens(data);
      setMeta(m);
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar os dados');
      setItens([]);
    } finally {
      setCarregando(false);
    }
  }, [caminho, chave]);

  useEffect(() => { void carregar(); }, [carregar]);

  return { itens, meta, carregando, erro, recarregar: carregar };
}
