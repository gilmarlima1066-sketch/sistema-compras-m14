/**
 * Central de alertas (secoes 40, 41 e 42).
 *
 * Uma central so, para os alertas de TODOS os modulos - nao um painel de
 * alertas por modulo. Cada alerta traz titulo, descricao, origem, prioridade,
 * data, status, responsavel e o caminho ate o registro que o originou.
 *
 * O contador de ocorrencias e a parte que muda o uso na pratica: um alerta que
 * reaparece nao vira uma nova linha na lista. Ele continua sendo o mesmo
 * alerta, com o numero de vezes que a condicao se repetiu - e a lista
 * permanece do tamanho dos problemas, nao do tamanho do tempo.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ErroApi } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { CabecalhoPagina } from '../componentes/Cabecalho';
import {
  Aviso, Cartao, Etiqueta, Indicador, Modal, Selecao, Vazio, dataHora, numero,
} from '../componentes/ui';

type Tom = 'perigo' | 'alerta' | 'info' | 'acento' | 'neutro';

const TOM_PRIORIDADE: Record<string, Tom> = {
  CRITICO: 'perigo', ALTO: 'perigo', MEDIO: 'alerta', BAIXO: 'info',
};

const TOM_STATUS: Record<string, Tom> = {
  ABERTO: 'alerta', EM_TRATATIVA: 'info', RESOLVIDO: 'acento', IGNORADO: 'neutro',
};

const PRIORIDADES = ['CRITICO', 'ALTO', 'MEDIO', 'BAIXO'];
const STATUS = ['ABERTO', 'EM_TRATATIVA', 'RESOLVIDO', 'IGNORADO'];

interface FiltroAlertas {
  status: string;
  prioridade: string;
  categoria: string;
  pagina: number;
}

export function Alertas() {
  const { pode } = useAuth();
  const [filtro, setFiltro] = useState<FiltroAlertas>({
    status: 'ABERTO', prioridade: '', categoria: '', pagina: 1,
  });
  const [resumo, setResumo] = useState<any>(null);
  const [lista, setLista] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aberto, setAberto] = useState<number | null>(null);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    void (async () => {
      try {
        const [r, l] = await Promise.all([
          api<any>('/alertas/resumo'),
          api<any>('/alertas', {
            query: {
              status: filtro.status || undefined,
              prioridade: filtro.prioridade || undefined,
              categoria: filtro.categoria || undefined,
              pagina: filtro.pagina,
              limite: 25,
            },
          }),
        ]);
        setResumo(r.data);
        setLista(l.data);
        setErro(null);
      } catch (e) {
        setErro(e instanceof ErroApi
          ? e.message
          : 'Falha ao carregar a central de alertas');
      }
    })();
  }, [filtro, recarga]);

  const total = lista?.total ?? 0;
  const paginas = Math.max(1, Math.ceil(total / (lista?.limite ?? 25)));

  return (
    <>
      <CabecalhoPagina
        titulo="Central de alertas"
        descricao="Todos os alertas do sistema em um lugar so, priorizados e sem repeticao."
      />

      {erro && <Aviso>{erro}</Aviso>}

      {resumo && (
        <Cartao titulo="Alertas em aberto">
          <div className="grade-indicadores">
            {PRIORIDADES.map((p) => (
              <button
                key={p}
                type="button"
                className="indicador-botao"
                onClick={() => setFiltro({ ...filtro, prioridade: p, status: 'ABERTO', pagina: 1 })}
              >
                <Indicador
                  rotulo={p}
                  valor={resumo.por_prioridade[p] ?? 0}
                  nota={resumo.significados[p]}
                  tom={TOM_PRIORIDADE[p]}
                />
              </button>
            ))}
            <Indicador
              rotulo="Reincidentes"
              valor={resumo.reincidentes}
              nota="Condicao que voltou a ocorrer sem ter sido tratada"
            />
          </div>

          <h4>Por categoria</h4>
          <div className="tabela-rolagem">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Categoria</th>
                  {PRIORIDADES.map((p) => <th key={p}>{p}</th>)}
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {resumo.categorias
                  .filter((c: string) => resumo.por_categoria[c])
                  .map((c: string) => {
                    const linha = resumo.por_categoria[c] ?? {};
                    const soma = PRIORIDADES.reduce((a, p) => a + (linha[p] ?? 0), 0);
                    return (
                      <tr key={c}>
                        <td>
                          <button
                            type="button"
                            className="botao botao--fantasma botao--pequeno"
                            onClick={() => setFiltro({
                              ...filtro, categoria: c, status: 'ABERTO', pagina: 1,
                            })}
                          >
                            {c}
                          </button>
                        </td>
                        {PRIORIDADES.map((p) => (
                          <td key={p} className="num">{linha[p] ?? '—'}</td>
                        ))}
                        <td className="num"><strong>{soma}</strong></td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          {Object.keys(resumo.por_categoria ?? {}).length === 0 && (
            <Vazio>Nenhum alerta em aberto.</Vazio>
          )}
        </Cartao>
      )}

      <Cartao titulo="Alertas">
        <div className="filtros">
          <Selecao
            rotulo="Situacao"
            valor={filtro.status}
            aoMudar={(v) => setFiltro({ ...filtro, status: v, pagina: 1 })}
            opcoes={STATUS.map((s) => ({ valor: s, texto: s.replace(/_/g, ' ') }))}
            vazio="Todas"
          />
          <Selecao
            rotulo="Prioridade"
            valor={filtro.prioridade}
            aoMudar={(v) => setFiltro({ ...filtro, prioridade: v, pagina: 1 })}
            opcoes={PRIORIDADES.map((p) => ({ valor: p, texto: p }))}
            vazio="Todas"
          />
          <Selecao
            rotulo="Categoria"
            valor={filtro.categoria}
            aoMudar={(v) => setFiltro({ ...filtro, categoria: v, pagina: 1 })}
            opcoes={(resumo?.categorias ?? []).map((c: string) => ({ valor: c, texto: c }))}
            vazio="Todas"
          />
        </div>

        {!lista ? <Vazio>Carregando…</Vazio> : lista.alertas.length === 0
          ? <Vazio>Nenhum alerta com esses filtros.</Vazio>
          : (
            <>
              <div className="tabela-rolagem">
                <table className="tabela">
                  <thead>
                    <tr>
                      <th>Prioridade</th><th>Titulo</th><th>Categoria</th><th>Origem</th>
                      <th>Ocorrencias</th><th>Ultima</th><th>Situacao</th><th>Responsavel</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {lista.alertas.map((a: any) => (
                      <tr key={a.id}>
                        <td>
                          <Etiqueta texto={a.prioridade} tom={TOM_PRIORIDADE[a.prioridade]} />
                        </td>
                        <td>
                          <strong>{a.titulo}</strong>
                          <div className="fraco">{a.descricao}</div>
                        </td>
                        <td>{a.categoria}</td>
                        <td className="fraco">{a.origem}</td>
                        <td className="num">
                          {a.ocorrencias > 1
                            ? <Etiqueta texto={`${a.ocorrencias}x`} tom="alerta" />
                            : a.ocorrencias}
                        </td>
                        <td>{dataHora(a.ultima_ocorrencia ?? a.data_geracao)}</td>
                        <td><Etiqueta texto={a.status} tom={TOM_STATUS[a.status]} /></td>
                        <td>{a.responsavel ?? <span className="fraco">—</span>}</td>
                        <td>
                          <button
                            type="button"
                            className="botao botao--pequeno botao--fantasma"
                            onClick={() => setAberto(a.id)}
                          >
                            Abrir
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="paginacao">
                <span className="num">{total}</span> alerta(s)
                <div className="paginacao__controles">
                  <button
                    type="button"
                    className="botao botao--pequeno"
                    disabled={filtro.pagina <= 1}
                    onClick={() => setFiltro({ ...filtro, pagina: filtro.pagina - 1 })}
                  >
                    Anterior
                  </button>
                  <span className="num">{filtro.pagina}/{paginas}</span>
                  <button
                    type="button"
                    className="botao botao--pequeno"
                    disabled={filtro.pagina >= paginas}
                    onClick={() => setFiltro({ ...filtro, pagina: filtro.pagina + 1 })}
                  >
                    Proxima
                  </button>
                </div>
              </div>
            </>
          )}
      </Cartao>

      {pode('bi.alertas') && <Regras />}

      {aberto !== null && (
        <DetalheAlerta
          id={aberto}
          aoFechar={() => setAberto(null)}
          aoTratar={() => { setAberto(null); setRecarga((r) => r + 1); }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function DetalheAlerta({ id, aoFechar, aoTratar }: {
  id: number; aoFechar: () => void; aoTratar: () => void;
}) {
  const navegar = useNavigate();
  const [alerta, setAlerta] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [observacao, setObservacao] = useState('');
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const { data } = await api<any>(`/alertas/${id}`);
        setAlerta(data);
      } catch (e) {
        setErro(e instanceof ErroApi ? e.message : 'Falha ao abrir o alerta');
      }
    })();
  }, [id]);

  const tratar = async (status: string) => {
    setSalvando(true);
    try {
      await api(`/alertas/${id}/tratar`, {
        metodo: 'PATCH',
        corpo: { status, observacao: observacao || undefined },
      });
      aoTratar();
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Falha ao atualizar o alerta');
      setSalvando(false);
    }
  };

  const aberto = alerta?.status === 'ABERTO' || alerta?.status === 'EM_TRATATIVA';

  return (
    <Modal
      titulo={alerta?.titulo ?? 'Alerta'}
      aoFechar={aoFechar}
      largo
      rodape={aberto ? (
        <>
          {alerta.status === 'ABERTO' && (
            <button
              type="button"
              className="botao botao--fantasma"
              disabled={salvando}
              onClick={() => void tratar('EM_TRATATIVA')}
            >
              Assumir
            </button>
          )}
          <button
            type="button"
            className="botao botao--fantasma"
            disabled={salvando}
            onClick={() => void tratar('IGNORADO')}
          >
            Ignorar
          </button>
          <button
            type="button"
            className="botao botao--primario"
            disabled={salvando}
            onClick={() => void tratar('RESOLVIDO')}
          >
            Marcar como resolvido
          </button>
        </>
      ) : undefined}
    >
      {erro && <Aviso>{erro}</Aviso>}
      {!alerta && !erro && <Vazio>Carregando…</Vazio>}

      {alerta && (
        <>
          <div className="grade-indicadores">
            <Indicador
              rotulo="Prioridade"
              valor={alerta.prioridade}
              nota={alerta.significado}
              tom={TOM_PRIORIDADE[alerta.prioridade]}
            />
            <Indicador rotulo="Situacao" valor={String(alerta.status).replace(/_/g, ' ')}
              tom={TOM_STATUS[alerta.status]} />
            <Indicador
              rotulo="Ocorrencias"
              valor={alerta.ocorrencias}
              nota={alerta.ocorrencias > 1
                ? 'A condicao voltou a ocorrer sem ter sido tratada'
                : 'Primeira ocorrencia'}
              tom={alerta.ocorrencias > 1 ? 'alerta' : 'neutro'}
            />
            {alerta.valor !== null && alerta.valor !== undefined && (
              <Indicador
                rotulo="Valor apurado"
                valor={numero(alerta.valor, 2)}
                nota={alerta.limite !== null && alerta.limite !== undefined
                  ? `Limite ${numero(alerta.limite, 2)}` : undefined}
              />
            )}
          </div>

          <dl className="definicoes">
            <dt>Descricao</dt><dd>{alerta.descricao}</dd>
            <dt>Categoria</dt><dd>{alerta.categoria}</dd>
            <dt>Origem</dt><dd>{alerta.origem}</dd>
            {alerta.kpi && (<><dt>Indicador</dt><dd>{alerta.kpi_nome} ({alerta.kpi})</dd></>)}
            {alerta.produto && (<><dt>Produto</dt><dd>{alerta.produto}</dd></>)}
            {alerta.fornecedor && (<><dt>Fornecedor</dt><dd>{alerta.fornecedor}</dd></>)}
            <dt>Primeira ocorrencia</dt>
            <dd>{dataHora(alerta.primeira_ocorrencia ?? alerta.data_geracao)}</dd>
            <dt>Ultima ocorrencia</dt>
            <dd>{dataHora(alerta.ultima_ocorrencia ?? alerta.data_geracao)}</dd>
            {alerta.data_resolucao && (
              <><dt>Resolvido em</dt><dd>{dataHora(alerta.data_resolucao)}</dd></>
            )}
            <dt>Responsavel</dt><dd>{alerta.responsavel ?? '—'}</dd>
          </dl>

          {alerta.link && (
            <button
              type="button"
              className="botao botao--fantasma"
              onClick={() => { aoFechar(); navegar('/indicadores'); }}
            >
              Ver o indicador que originou o alerta
            </button>
          )}

          {aberto && (
            <div className="campo">
              <label htmlFor="tratativa">Observacao da tratativa</label>
              <textarea
                id="tratativa"
                rows={3}
                value={observacao}
                onChange={(e) => setObservacao(e.target.value)}
                placeholder="O que foi verificado e decidido"
              />
            </div>
          )}

          <p className="fraco">
            Encerrar o alerta registra a tratativa. Nao altera estoque, pedido nem
            recebimento: a correcao e feita no modulo de origem.
          </p>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function Regras() {
  const [regras, setRegras] = useState<any[]>([]);
  const [resultado, setResultado] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [rodando, setRodando] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const { data } = await api<any[]>('/alertas/regras');
        setRegras(data ?? []);
      } catch { /* a lista de regras e informativa */ }
    })();
  }, []);

  const avaliar = async () => {
    setRodando(true);
    try {
      const { data } = await api<any>('/alertas/avaliar', { metodo: 'POST', corpo: {} });
      setResultado(data);
      setErro(null);
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Falha ao avaliar as regras');
    } finally {
      setRodando(false);
    }
  };

  return (
    <Cartao
      titulo="Regras de alerta"
      acoes={(
        <button
          type="button"
          className="botao botao--fantasma botao--pequeno"
          disabled={rodando}
          onClick={() => void avaliar()}
        >
          {rodando ? 'Avaliando…' : 'Avaliar agora'}
        </button>
      )}
    >
      {erro && <Aviso>{erro}</Aviso>}
      <p className="fraco">
        Avaliar de novo nao duplica alerta: se a condicao ja tem alerta aberto, ele e
        atualizado e a ocorrencia e contada.
      </p>

      <div className="tabela-rolagem">
        <table className="tabela">
          <thead>
            <tr>
              <th>Regra</th><th>Indicador</th><th>Condicao</th><th>Janela</th>
              <th>Prioridade</th><th>Ultima avaliacao</th>
            </tr>
          </thead>
          <tbody>
            {regras.map((r) => {
              const disparo = (resultado?.disparos ?? []).find((d: any) => d.regra === r.codigo);
              return (
                <tr key={r.codigo}>
                  <td>
                    <strong>{r.nome}</strong>
                    <div className="fraco">{r.descricao}</div>
                  </td>
                  <td>{r.kpi_codigo ?? <span className="fraco">—</span>}</td>
                  <td>
                    {String(r.comparador).replace(/_/g, ' ').toLowerCase()}
                    {r.limite !== null && r.limite !== undefined && ` ${numero(r.limite, 2)}`}
                  </td>
                  <td className="num">{r.janela_dias}d</td>
                  <td>
                    <Etiqueta texto={r.prioridade} tom={TOM_PRIORIDADE[r.prioridade]} />
                  </td>
                  <td className="fraco">
                    {!disparo ? '—' : (
                      <>
                        <Etiqueta
                          texto={disparo.disparou ? 'DISPAROU' : 'OK'}
                          tom={disparo.disparou ? 'perigo' : 'acento'}
                        />
                        {' '}{disparo.motivo}
                        {disparo.disparou && disparo.novo === false
                          && ` (${disparo.ocorrencias}ª ocorrencia do mesmo alerta)`}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Cartao>
  );
}
