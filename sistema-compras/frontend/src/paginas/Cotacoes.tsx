import { useEffect, useState } from 'react';
import { api, ErroApi } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useLista } from '../hooks/useLista';
import { CabecalhoPagina } from '../componentes/Cabecalho';
import {
  Aviso, Cartao, Entrada, Etiqueta, Indicador, Modal, Paginacao, Selecao, Vazio,
  data as fmtData, moeda, numero,
} from '../componentes/ui';
import { GraficoBarras } from '../componentes/graficos';

type Aba = 'dashboard' | 'lista' | 'nova';

const TOM_STATUS: Record<string, 'perigo' | 'alerta' | 'info' | 'acento' | 'neutro'> = {
  RASCUNHO: 'neutro', ENVIADA: 'info', AGUARDANDO_RESPOSTAS: 'alerta',
  EM_ANALISE: 'info', NEGOCIACAO_NECESSARIA: 'alerta',
  APROVADA_NEGOCIACAO: 'acento', ENCAMINHADA: 'acento',
  REJEITADA: 'perigo', CANCELADA: 'perigo',
  PENDENTE: 'neutro', NAO_ENVIADO: 'neutro', VISUALIZADO: 'info',
  RESPONDIDA: 'acento', PARCIALMENTE_RESPONDIDA: 'alerta',
  RECUSADA: 'perigo', EXPIRADO: 'perigo',
};

const METRICAS = [
  { valor: 'CUSTO_UNITARIO', texto: 'Custo unitario' },
  { valor: 'CUSTO_TOTAL', texto: 'Custo total' },
  { valor: 'PRECO_UNITARIO', texto: 'Preco unitario' },
  { valor: 'PRECO_LIQUIDO', texto: 'Preco liquido' },
  { valor: 'PRAZO', texto: 'Prazo de entrega' },
  { valor: 'PAGAMENTO', texto: 'Prazo de pagamento' },
  { valor: 'MOQ', texto: 'MOQ' },
  { valor: 'SCORE', texto: 'Score' },
  { valor: 'DISPONIBILIDADE', texto: 'Disponibilidade' },
];

export function Cotacoes() {
  const { pode } = useAuth();
  const [aba, setAba] = useState<Aba>('dashboard');
  const [aberta, setAberta] = useState<number | null>(null);

  return (
    <>
      <CabecalhoPagina
        titulo="Cotacoes"
        descricao="Convite a fornecedores, propostas recebidas, comparacao por criterios e recomendacao."
      />

      <nav className="abas">
        {([
          { id: 'dashboard' as Aba, texto: 'Dashboard' },
          { id: 'lista' as Aba, texto: 'Cotacoes' },
          ...(pode('cotacoes.criar') ? [{ id: 'nova' as Aba, texto: 'Nova cotacao' }] : []),
        ]).map((a) => (
          <button
            key={a.id}
            type="button"
            className={`abas__item${aba === a.id ? ' abas__item--ativo' : ''}`}
            onClick={() => setAba(a.id)}
          >
            {a.texto}
          </button>
        ))}
      </nav>

      {aba === 'dashboard' && <PainelDashboard />}
      {aba === 'lista' && <PainelLista aoAbrir={setAberta} />}
      {aba === 'nova' && <PainelNova aoCriar={(id) => { setAberta(id); setAba('lista'); }} />}

      {aberta !== null && (
        <ModalCotacao cotacaoId={aberta} aoFechar={() => setAberta(null)} />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ dashboard */

function PainelDashboard() {
  const [dados, setDados] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    api<any>('/cotacoes/dashboard')
      .then((r) => setDados(r.data))
      .catch((e) => setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar'));
  }, []);

  if (erro) return <Aviso>{erro}</Aviso>;
  if (!dados) return <Vazio>Carregando…</Vazio>;
  const i = dados.indicadores ?? {};

  return (
    <>
      <div className="grade-indicadores">
        <Indicador rotulo="Cotacoes abertas" valor={numero(i.rascunho)} />
        <Indicador rotulo="Aguardando resposta" valor={numero(i.aguardando)} tom="alerta" />
        <Indicador rotulo="Em analise" valor={numero(i.em_analise)} tom="info" />
        <Indicador rotulo="Vencidas" valor={numero(i.vencidas)} tom="perigo" />
        <Indicador rotulo="Negociacao necessaria" valor={numero(i.negociacao)} tom="alerta" />
        <Indicador rotulo="Aprovadas" valor={numero(i.aprovadas)} tom="acento" />
        <Indicador rotulo="Rejeitadas" valor={numero(i.rejeitadas)} />
        <Indicador rotulo="Valor total cotado" valor={moeda(i.valor_total_cotado)} tom="acento" />
        <Indicador rotulo="Valor medio da proposta" valor={moeda(i.valor_medio_proposta)} />
        <Indicador rotulo="Fornecedores participantes" valor={numero(i.fornecedores_participantes)} />
        <Indicador rotulo="Produtos cotados" valor={numero(i.produtos_cotados)} />
        <Indicador rotulo="Produtos sem resposta" valor={numero(i.produtos_sem_resposta)} tom="alerta" />
        <Indicador
          rotulo="Itens com diferenca relevante"
          valor={numero(i.produtos_com_divergencia)}
          nota="entre a melhor e a pior proposta"
          tom="info"
        />
      </div>

      {(dados.por_status ?? []).length > 0 && (
        <Cartao titulo="Cotacoes por status">
          <GraficoBarras
            dados={dados.por_status.map((s: any) => ({
              rotulo: String(s.status).replace(/_/g, ' ').slice(0, 10),
              valor: Number(s.cotacoes),
            }))}
          />
        </Cartao>
      )}

      {(dados.por_fornecedor ?? []).length > 0 && (
        <Cartao titulo="Valor cotado por fornecedor" semCorpo>
          <table className="tabela">
            <thead>
              <tr><th>Fornecedor</th><th className="num">Cotacoes</th><th className="num">Valor</th></tr>
            </thead>
            <tbody>
              {dados.por_fornecedor.map((f: any) => (
                <tr key={f.fornecedor}>
                  <td>{f.fornecedor}</td>
                  <td className="num">{numero(f.cotacoes)}</td>
                  <td className="num">{moeda(f.valor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Cartao>
      )}
    </>
  );
}

/* ----------------------------------------------------------------------- lista */

function PainelLista({ aoAbrir }: { aoAbrir: (id: number) => void }) {
  const [pagina, setPagina] = useState(1);
  const [busca, setBusca] = useState('');
  const [status, setStatus] = useState('');
  const [vencidas, setVencidas] = useState(false);

  const { itens, meta, carregando } = useLista<any>('/cotacoes', {
    pagina, limite: 25, busca, status, apenas_vencidas: vencidas || undefined,
  });

  return (
    <Cartao
      titulo="Cotacoes"
      acoes={(
        <div className="filtros">
          <Entrada rotulo="Buscar" valor={busca} aoMudar={(v) => { setBusca(v); setPagina(1); }} placeholder="numero" />
          <Selecao
            rotulo="Status" valor={status} aoMudar={(v) => { setStatus(v); setPagina(1); }}
            opcoes={['RASCUNHO', 'AGUARDANDO_RESPOSTAS', 'EM_ANALISE', 'NEGOCIACAO_NECESSARIA',
              'APROVADA_NEGOCIACAO', 'ENCAMINHADA', 'REJEITADA', 'CANCELADA']
              .map((s) => ({ valor: s, texto: s.replace(/_/g, ' ') }))}
          />
          <label className="campo">
            <span>Vencidas</span>
            <input type="checkbox" checked={vencidas} onChange={(e) => { setVencidas(e.target.checked); setPagina(1); }} />
          </label>
        </div>
      )}
      semCorpo
    >
      {carregando && <Vazio>Carregando…</Vazio>}
      {!carregando && !itens.length && <Vazio>Nenhuma cotacao no filtro informado.</Vazio>}
      {!!itens.length && (
        <div className="tabela-rolagem">
          <table className="tabela">
            <thead>
              <tr>
                <th>Numero</th><th>Abertura</th><th>Limite</th><th>Prioridade</th>
                <th className="num">Produtos</th><th className="num">Convidados</th>
                <th className="num">Responderam</th><th>Comprador</th><th>Status</th><th />
              </tr>
            </thead>
            <tbody>
              {itens.map((c) => (
                <tr key={c.id} className={c.vencida ? 'linha-alerta' : undefined}>
                  <td className="mono">{c.numero}</td>
                  <td>{fmtData(c.data_abertura)}</td>
                  <td>{fmtData(c.data_limite)}{c.vencida && <> <Etiqueta texto="VENCIDA" tom="perigo" /></>}</td>
                  <td><Etiqueta texto={c.prioridade} /></td>
                  <td className="num">{numero(c.produtos)}</td>
                  <td className="num">{numero(c.fornecedores)}</td>
                  <td className="num">{numero(c.respondidos)}</td>
                  <td>{c.comprador ?? '—'}</td>
                  <td><Etiqueta texto={c.status} tom={TOM_STATUS[c.status]} /></td>
                  <td>
                    <button type="button" className="botao botao--pequeno botao--fantasma" onClick={() => aoAbrir(c.id)}>
                      Abrir
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Paginacao meta={meta} aoTrocar={setPagina} />
    </Cartao>
  );
}

/* ------------------------------------------------------------------ nova cotacao */

function PainelNova({ aoCriar }: { aoCriar: (id: number) => void }) {
  const [requisicoes, setRequisicoes] = useState<any[]>([]);
  const [requisicaoId, setRequisicaoId] = useState('');
  const [dataLimite, setDataLimite] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [criando, setCriando] = useState(false);

  useEffect(() => {
    api<any[]>('/compras/requisicoes', { query: { status: 'APROVADA', limite: 50 } })
      .then((r) => setRequisicoes(r.data)).catch(() => undefined);
  }, []);

  async function criar() {
    setCriando(true);
    setErro(null);
    try {
      const { data } = await api<any>('/cotacoes', {
        metodo: 'POST',
        corpo: {
          origem: 'REQUISICAO',
          requisicao_id: Number(requisicaoId),
          ...(dataLimite ? { data_limite: dataLimite } : {}),
        },
      });
      setAviso(`Cotacao ${data.numero} criada com ${data.produtos} produto(s).`);
      aoCriar(data.id);
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Falha ao criar a cotacao');
    } finally {
      setCriando(false);
    }
  }

  return (
    <Cartao titulo="Nova cotacao a partir de requisicao aprovada">
      {aviso && <Aviso tipo="ok">{aviso}</Aviso>}
      {erro && <Aviso>{erro}</Aviso>}
      {!requisicoes.length && (
        <Vazio>
          Nenhuma requisicao aprovada disponivel. Aprove uma requisicao em Compras antes de cotar.
        </Vazio>
      )}
      {!!requisicoes.length && (
        <>
          <div className="filtros">
            <Selecao
              rotulo="Requisicao" valor={requisicaoId} aoMudar={setRequisicaoId}
              opcoes={requisicoes.map((r) => ({
                valor: String(r.id),
                texto: `${r.numero} — ${moeda(r.valor_estimado)}`,
              }))}
            />
            <Entrada rotulo="Data limite de resposta" tipo="date" valor={dataLimite} aoMudar={setDataLimite} />
            <button type="button" className="botao" disabled={!requisicaoId || criando} onClick={() => void criar()}>
              {criando ? 'Criando…' : 'Criar cotacao'}
            </button>
          </div>
          <p className="fraco">
            Quantidade, unidade, MOQ, multiplo, lead time e data necessaria vem da requisicao —
            nada e pedido de novo.
          </p>
        </>
      )}
    </Cartao>
  );
}

/* --------------------------------------------------------------- detalhe / modal */

function ModalCotacao({ cotacaoId, aoFechar }: { cotacaoId: number; aoFechar: () => void }) {
  const { pode } = useAuth();
  const [painel, setPainel] = useState<'resumo' | 'comparativo' | 'matriz' | 'cenarios'>('resumo');
  const [cotacao, setCotacao] = useState<any>(null);
  const [comparativo, setComparativo] = useState<any>(null);
  const [recomendacao, setRecomendacao] = useState<any>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [explicando, setExplicando] = useState<any>(null);

  async function carregar() {
    try {
      const [c, cmp] = await Promise.all([
        api<any>(`/cotacoes/${cotacaoId}`),
        api<any>(`/cotacoes/${cotacaoId}/comparativo`).catch(() => ({ data: null })),
      ]);
      setCotacao(c.data);
      setComparativo(cmp.data);
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Falha ao carregar a cotacao');
    }
  }

  useEffect(() => { void carregar(); }, [cotacaoId]);

  async function acao(caminho: string, corpo?: unknown, mensagem?: string) {
    setErro(null);
    try {
      await api(caminho, { metodo: 'POST', corpo: corpo ?? {} });
      setAviso(mensagem ?? 'Operacao concluida');
      await carregar();
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Falha na operacao');
    }
  }

  async function analisar() {
    setErro(null);
    try {
      const { data } = await api<any>(`/cotacoes/${cotacaoId}/analisar`, { metodo: 'POST', corpo: {} });
      setComparativo(data);
      const rec = await api<any>(`/cotacoes/${cotacaoId}/recomendacao`);
      setRecomendacao(rec.data);
      setAviso('Comparativo recalculado.');
      setPainel('comparativo');
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Falha ao analisar');
    }
  }

  if (!cotacao) {
    return (
      <Modal titulo="Cotacao" aoFechar={aoFechar}>
        {erro ? <Aviso>{erro}</Aviso> : <Vazio>Carregando…</Vazio>}
      </Modal>
    );
  }

  return (
    <Modal titulo={`Cotacao ${cotacao.numero}`} aoFechar={aoFechar} largo>
      {aviso && <Aviso tipo="ok">{aviso}</Aviso>}
      {erro && <Aviso>{erro}</Aviso>}

      <div className="grade-indicadores">
        <Indicador rotulo="Status" valor={<Etiqueta texto={cotacao.status} tom={TOM_STATUS[cotacao.status]} />} />
        <Indicador rotulo="Produtos" valor={numero(cotacao.produtos?.length)} />
        <Indicador rotulo="Convidados" valor={numero(cotacao.fornecedores?.length)} />
        <Indicador
          rotulo="Responderam"
          valor={numero((cotacao.fornecedores ?? [])
            .filter((f: any) => ['RESPONDIDA', 'PARCIALMENTE_RESPONDIDA'].includes(f.status)).length)}
        />
        <Indicador rotulo="Data limite" valor={fmtData(cotacao.data_limite)} />
        <Indicador rotulo="Valor selecionado" valor={moeda(cotacao.valor_selecionado)} tom="acento" />
      </div>

      <nav className="abas">
        {([
          { id: 'resumo', texto: 'Fornecedores e criterios' },
          { id: 'comparativo', texto: 'Comparativo' },
          { id: 'matriz', texto: 'Matriz' },
          { id: 'cenarios', texto: 'Cenarios' },
        ] as const).map((p) => (
          <button
            key={p.id} type="button"
            className={`abas__item${painel === p.id ? ' abas__item--ativo' : ''}`}
            onClick={() => setPainel(p.id)}
          >
            {p.texto}
          </button>
        ))}
      </nav>

      {painel === 'resumo' && (
        <>
          <Cartao
            titulo="Fornecedores convidados"
            acoes={pode('cotacoes.editar') && cotacao.status === 'RASCUNHO' ? (
              <button type="button" className="botao botao--pequeno"
                onClick={() => void acao(`/cotacoes/${cotacaoId}/enviar`, { canal: 'EMAIL' }, 'Cotacao enviada')}>
                Enviar cotacao
              </button>
            ) : undefined}
            semCorpo
          >
            <table className="tabela">
              <thead>
                <tr>
                  <th>Fornecedor</th><th>Origem</th><th>Status</th>
                  <th>Enviado</th><th>Respondido</th>
                  <th className="num">Respondidos</th><th className="num">Lembretes</th>
                </tr>
              </thead>
              <tbody>
                {(cotacao.fornecedores ?? []).map((f: any) => (
                  <tr key={f.id}>
                    <td>{f.razao_social}</td>
                    <td className="fraco">{f.origem_fornecedor}</td>
                    <td><Etiqueta texto={f.status} tom={TOM_STATUS[f.status]} /></td>
                    <td>{fmtData(f.data_envio)}</td>
                    <td>{fmtData(f.data_resposta)}</td>
                    <td className="num">{numero(f.itens_respondidos)}/{numero(f.itens_solicitados)}</td>
                    <td className="num">{numero(f.lembretes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Cartao>

          <Cartao titulo="Criterios e pesos">
            <table className="tabela">
              <thead>
                <tr><th>Criterio</th><th>Direcao</th><th className="num">Peso</th><th>Descricao</th></tr>
              </thead>
              <tbody>
                {(cotacao.criterios ?? []).map((c: any) => (
                  <tr key={c.codigo}>
                    <td>{c.nome}</td>
                    <td className="fraco">{c.direcao === 'MENOR_MELHOR' ? 'menor e melhor' : 'maior e melhor'}</td>
                    <td className="num">{numero(c.peso, 1)}%</td>
                    <td className="fraco">{c.descricao}</td>
                  </tr>
                ))}
                <tr>
                  <th>Total</th><td /><td className="num">
                    <strong>{numero((cotacao.criterios ?? []).reduce((a: number, c: any) => a + Number(c.peso), 0), 1)}%</strong>
                  </td><td />
                </tr>
              </tbody>
            </table>
          </Cartao>

          {pode('cotacoes.analisar') && (
            <Cartao titulo="Analise">
              <button type="button" className="botao" onClick={() => void analisar()}>
                Calcular comparativo e score
              </button>
              <p className="fraco">
                Recalcula elegibilidade, pontuacao por criterio e recomendacao com os pesos acima.
              </p>
            </Cartao>
          )}

          <Cartao titulo="Historico" semCorpo>
            <table className="tabela">
              <thead><tr><th>Quando</th><th>De</th><th>Para</th><th>Usuario</th><th>Justificativa</th></tr></thead>
              <tbody>
                {(cotacao.historico ?? []).map((h: any) => (
                  <tr key={h.id}>
                    <td>{fmtData(h.created_at)}</td>
                    <td className="fraco">{h.status_anterior ?? '—'}</td>
                    <td><Etiqueta texto={h.status_novo} tom={TOM_STATUS[h.status_novo]} /></td>
                    <td>{h.usuario ?? '—'}</td>
                    <td className="fraco">{h.justificativa ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Cartao>
        </>
      )}

      {painel === 'comparativo' && (
        <PainelComparativo
          comparativo={comparativo}
          recomendacao={recomendacao}
          aoExplicar={setExplicando}
        />
      )}

      {painel === 'matriz' && <PainelMatriz cotacaoId={cotacaoId} />}
      {painel === 'cenarios' && <PainelCenarios cotacaoId={cotacaoId} podeSimular={pode('cotacoes.analisar')} />}

      {explicando && <ModalPontuacao itemId={explicando} aoFechar={() => setExplicando(null)} />}
    </Modal>
  );
}

function PainelComparativo({ comparativo, recomendacao, aoExplicar }: {
  comparativo: any; recomendacao: any; aoExplicar: (id: number) => void;
}) {
  if (!comparativo) return <Vazio>Calcule o comparativo para ver as propostas.</Vazio>;

  return (
    <>
      {(comparativo.produtos ?? []).map((p: any) => (
        <Cartao
          key={p.cotacao_produto_id}
          titulo={`${p.codigo} — ${p.descricao} · ${numero(p.quantidade_pedida)} ${p.unidade ?? ''}`}
          semCorpo
        >
          {p.sem_resposta && <Vazio>Nenhum fornecedor respondeu este item.</Vazio>}
          {!p.sem_resposta && (
            <>
              {p.divergencia_relevante && (
                <Aviso>
                  Diferenca de {numero(p.dispersao_percentual, 1)}% entre a melhor e a pior proposta.
                </Aviso>
              )}
              <div className="tabela-rolagem">
                <table className="tabela">
                  <thead>
                    <tr>
                      <th>Fornecedor</th><th className="num">Ofertado</th>
                      <th className="num">Preco</th><th className="num">Frete</th>
                      <th className="num">Custo total</th><th className="num">Custo unit.</th>
                      <th className="num">Prazo</th><th className="num">Pgto</th>
                      <th className="num">MOQ</th><th>Disp.</th>
                      <th className="num">OTIF</th><th className="num">Qual.</th>
                      <th className="num">x historico</th>
                      <th className="num">Score</th><th>Situacao</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {p.propostas.map((x: any) => (
                      <tr key={x.cotacao_item_id} className={x.recomendado ? 'linha-destaque' : undefined}>
                        <td>
                          {x.fornecedor}
                          {x.moeda !== 'BRL' && <> <Etiqueta texto={x.moeda} tom="info" /></>}
                          {x.incoterm && <> <Etiqueta texto={x.incoterm} /></>}
                        </td>
                        <td className="num">{numero(x.quantidade_ofertada)}
                          {Number(x.atendimento_percentual) < 100 && (
                            <div className="fraco">{numero(x.atendimento_percentual, 0)}%</div>
                          )}
                        </td>
                        <td className="num">{numero(x.preco_unitario, 4)}</td>
                        <td className="num">{moeda(x.frete)}</td>
                        <td className="num"><strong>{moeda(x.custo_total_base)}</strong></td>
                        <td className="num">{numero(x.custo_efetivo_unitario, 4)}</td>
                        <td className="num">{x.prazo_entrega_dias ?? '—'}</td>
                        <td className="num">{x.prazo_pagamento_dias ?? '—'}</td>
                        <td className="num">{x.moq === null ? '—' : numero(x.moq)}</td>
                        <td className="fraco">{x.disponibilidade ?? '—'}</td>
                        <td className="num">{x.otif === null ? '—' : numero(x.otif, 0)}</td>
                        <td className="num">{x.qualidade === null ? '—' : numero(x.qualidade, 0)}</td>
                        <td className="num">
                          {x.variacao_ultima_compra === null ? '—' : (
                            <Etiqueta
                              texto={`${Number(x.variacao_ultima_compra) > 0 ? '+' : ''}${numero(x.variacao_ultima_compra, 1)}%`}
                              tom={Number(x.variacao_ultima_compra) > 0 ? 'perigo' : 'acento'}
                            />
                          )}
                        </td>
                        <td className="num">{x.score === null ? '—' : <strong>{numero(x.score, 1)}</strong>}</td>
                        <td>
                          {x.elegivel
                            ? (x.recomendado ? <Etiqueta texto="RECOMENDADA" tom="acento" /> : <Etiqueta texto="ELEGIVEL" />)
                            : <Etiqueta texto="NAO ELEGIVEL" tom="perigo" />}
                        </td>
                        <td>
                          <button type="button" className="botao botao--pequeno botao--fantasma"
                            onClick={() => aoExplicar(x.cotacao_item_id)}>
                            Por que?
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {p.propostas.filter((x: any) => !x.elegivel).map((x: any) => (
                <div key={`m${x.cotacao_item_id}`} className="cartao__corpo">
                  <strong>{x.fornecedor}</strong> nao elegivel:
                  <ul className="lista-alertas">
                    {(x.motivos_inelegibilidade ?? []).map((m: any, idx: number) => (
                      <li key={idx}><Etiqueta texto={m.criterio} tom="perigo" /> {m.motivo}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}
        </Cartao>
      ))}

      {recomendacao && (
        <Cartao titulo="Recomendacao">
          {(recomendacao.por_produto ?? []).map((p: any) => (
            <p key={p.cotacao_produto_id} className="explicacao">
              <strong>{p.codigo}</strong> — {p.explicacao}
            </p>
          ))}
        </Cartao>
      )}
    </>
  );
}

function PainelMatriz({ cotacaoId }: { cotacaoId: number }) {
  const [metrica, setMetrica] = useState('CUSTO_UNITARIO');
  const [dados, setDados] = useState<any>(null);

  useEffect(() => {
    api<any>(`/cotacoes/${cotacaoId}/matriz`, { query: { metrica } })
      .then((r) => setDados(r.data)).catch(() => setDados(null));
  }, [cotacaoId, metrica]);

  return (
    <Cartao
      titulo="Matriz produto x fornecedor"
      acoes={<Selecao rotulo="Metrica" valor={metrica} aoMudar={setMetrica} opcoes={METRICAS} vazio={null} />}
      semCorpo
    >
      {!dados && <Vazio>Carregando…</Vazio>}
      {dados && (
        <div className="tabela-rolagem">
          <table className="tabela">
            <thead>
              <tr>
                <th>Produto</th><th className="num">Qtd</th>
                {(dados.fornecedores ?? []).map((f: any) => <th key={f.fornecedor_id} className="num">{f.fornecedor}</th>)}
              </tr>
            </thead>
            <tbody>
              {(dados.linhas ?? []).map((l: any) => (
                <tr key={l.cotacao_produto_id}>
                  <td>{l.codigo} — {l.descricao}</td>
                  <td className="num">{numero(l.quantidade)}</td>
                  {l.valores.map((v: any) => (
                    <td key={v.fornecedor_id} className="num"
                      style={{ background: v.recomendado ? 'rgba(47,111,78,.16)' : undefined }}>
                      {v.sem_resposta
                        ? <span className="fraco">sem resposta</span>
                        : v.valor === null ? '—'
                          : (typeof v.valor === 'number' ? numero(v.valor, 2) : String(v.valor))}
                      {!v.sem_resposta && !v.elegivel && <div className="fraco">nao elegivel</div>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Cartao>
  );
}

function PainelCenarios({ cotacaoId, podeSimular }: { cotacaoId: number; podeSimular: boolean }) {
  const [cenarios, setCenarios] = useState<any[]>([]);
  const [tipo, setTipo] = useState('MENOR_CUSTO');
  const [erro, setErro] = useState<string | null>(null);

  const carregar = () => api<any[]>(`/cotacoes/${cotacaoId}/cenarios`)
    .then((r) => setCenarios(r.data)).catch(() => undefined);
  useEffect(() => { void carregar(); }, [cotacaoId]);

  async function simular() {
    setErro(null);
    try {
      await api(`/cotacoes/${cotacaoId}/cenarios`, {
        metodo: 'POST',
        corpo: { nome: `${tipo} ${new Date().toLocaleTimeString('pt-BR')}`, tipo },
      });
      await carregar();
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Falha ao simular');
    }
  }

  return (
    <Cartao
      titulo="Cenarios de comparacao"
      acoes={podeSimular ? (
        <div className="filtros">
          <Selecao
            rotulo="Cenario" valor={tipo} aoMudar={setTipo} vazio={null}
            opcoes={[
              { valor: 'MENOR_CUSTO', texto: 'Menor custo' },
              { valor: 'MENOR_PRAZO', texto: 'Menor prazo' },
              { valor: 'MAIOR_PRAZO_PAGAMENTO', texto: 'Maior prazo de pagamento' },
              { valor: 'MELHOR_SCORE', texto: 'Melhor score' },
              { valor: 'COMPRA_DIVIDIDA', texto: 'Compra dividida' },
            ]}
          />
          <button type="button" className="botao botao--pequeno" onClick={() => void simular()}>Simular</button>
        </div>
      ) : undefined}
      semCorpo
    >
      {erro && <Aviso>{erro}</Aviso>}
      {!cenarios.length && <Vazio>Nenhum cenario simulado.</Vazio>}
      {!!cenarios.length && (
        <div className="tabela-rolagem">
          <table className="tabela">
            <thead>
              <tr>
                <th>Cenario</th><th>Tipo</th>
                <th className="num">Custo total</th><th className="num">Custo/unidade</th>
                <th className="num">Atendimento</th><th className="num">Fornecedores</th>
                <th className="num">Prazo max.</th><th className="num">Score medio</th>
              </tr>
            </thead>
            <tbody>
              {cenarios.map((c) => (
                <tr key={c.id}>
                  <td>{c.nome}</td>
                  <td><Etiqueta texto={c.tipo} /></td>
                  <td className="num">{moeda(c.custo_total)}</td>
                  <td className="num"><strong>{numero(c.custo_por_unidade, 4)}</strong></td>
                  <td className="num">{numero(c.atendimento_percentual, 1)}%</td>
                  <td className="num">{numero(c.fornecedores)}</td>
                  <td className="num">{c.prazo_maximo_dias ?? '—'}</td>
                  <td className="num">{c.score_medio === null ? '—' : numero(c.score_medio, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="cartao__corpo">
            <p className="fraco">
              Compare pelo custo por unidade atendida: o cenario que compra menos sempre soma menos
              no total, o que nao quer dizer que seja mais barato.
            </p>
          </div>
        </div>
      )}
    </Cartao>
  );
}

function ModalPontuacao({ itemId, aoFechar }: { itemId: number; aoFechar: () => void }) {
  const [dados, setDados] = useState<any>(null);

  useEffect(() => {
    api<any>(`/cotacoes/propostas/${itemId}/pontuacao`)
      .then((r) => setDados(r.data)).catch(() => setDados(null));
  }, [itemId]);

  if (!dados) {
    return <Modal titulo="Como esta proposta foi avaliada" aoFechar={aoFechar}><Vazio>Carregando…</Vazio></Modal>;
  }

  return (
    <Modal
      titulo={`Como esta proposta foi avaliada — ${dados.proposta.fornecedor}`}
      aoFechar={aoFechar}
      largo
    >
      {!dados.elegivel && (
        <Aviso>
          Proposta nao elegivel:
          <ul className="lista-alertas">
            {(dados.motivos_inelegibilidade ?? []).map((m: any, i: number) => (
              <li key={i}><Etiqueta texto={m.criterio} tom="perigo" /> {m.motivo}</li>
            ))}
          </ul>
        </Aviso>
      )}

      <Cartao titulo="Custo total de aquisicao">
        <table className="tabela">
          <tbody>
            <tr><th>Produtos</th><td className="num">{moeda(dados.custo.valor_produtos)}</td></tr>
            <tr><th>Desconto</th><td className="num">- {moeda(dados.custo.desconto)}</td></tr>
            <tr><th>Frete</th><td className="num">{moeda(dados.custo.frete)}</td></tr>
            <tr><th>Impostos</th><td className="num">{moeda(dados.custo.impostos)}</td></tr>
            <tr><th>Seguro</th><td className="num">{moeda(dados.custo.seguro)}</td></tr>
            <tr><th>Desembaraco</th><td className="num">{moeda(dados.custo.desembaraco)}</td></tr>
            <tr><th>Taxas</th><td className="num">{moeda(dados.custo.taxas)}</td></tr>
            <tr><th>Outros custos</th><td className="num">{moeda(dados.custo.outros_custos)}</td></tr>
            <tr><th>Custo total</th><td className="num"><strong>{moeda(dados.custo.custo_total)}</strong></td></tr>
            <tr><th>Custo unitario</th><td className="num">{numero(dados.custo.custo_unitario, 4)}</td></tr>
          </tbody>
        </table>
        <p className="explicacao">{dados.custo.formula}</p>
      </Cartao>

      <Cartao titulo="Pontuacao por criterio">
        <table className="tabela">
          <thead>
            <tr>
              <th>Criterio</th><th>Valor</th><th className="num">Pontuacao</th>
              <th className="num">Peso</th><th className="num">Ponderada</th><th>Observacao</th>
            </tr>
          </thead>
          <tbody>
            {(dados.criterios ?? []).map((c: any) => (
              <tr key={c.codigo}>
                <td>{c.nome}</td>
                <td>{c.valor_texto ?? (c.valor_original === null ? '—' : numero(c.valor_original, 2))}</td>
                <td className="num">
                  {c.dados_insuficientes
                    ? <Etiqueta texto="DADOS INSUFICIENTES" tom="neutro" />
                    : numero(c.pontuacao, 1)}
                </td>
                <td className="num">{numero(c.peso, 1)}%</td>
                <td className="num">{c.dados_insuficientes ? '—' : numero(c.pontuacao_ponderada, 2)}</td>
                <td className="fraco">{c.observacao ?? '—'}</td>
              </tr>
            ))}
            <tr>
              <th>Total</th><td /><td />
              <td className="num"><strong>{numero(dados.soma_pesos_utilizados, 1)}%</strong></td>
              <td className="num"><strong>{numero(dados.soma_ponderada, 2)}</strong></td>
              <td />
            </tr>
            <tr>
              <th>Score</th><td colSpan={4} className="num">
                <strong>{numero(dados.score, 2)}</strong>
              </td><td className="fraco">{dados.formula_score}</td>
            </tr>
          </tbody>
        </table>
      </Cartao>
    </Modal>
  );
}
