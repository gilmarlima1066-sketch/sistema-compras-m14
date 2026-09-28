/**
 * Modulo 12 - camada de inteligencia.
 *
 * Tres compromissos que a tela leva a serio:
 *
 * 1. Nada de caixa-preta (secao 46). Toda recomendacao abre mostrando a conta,
 *    as evidencias, as premissas e a fonte. O botao "Ver evidencias" nao e um
 *    extra: e o que separa apoio a decisao de palpite com ar de autoridade.
 *
 * 2. A natureza de cada afirmacao fica visivel (secao 47). FATO, CALCULO,
 *    PREVISAO, HIPOTESE e SIMULACAO aparecem etiquetados, porque "o estoque e
 *    850" e "o estoque acaba em 6 dias" nao merecem a mesma confianca.
 *
 * 3. A IA nao executa (secao 48). O que a tela oferece e registrar a decisao e
 *    navegar ate o modulo que tem a alcada. Nenhum botao aqui emite pedido,
 *    move estoque ou bloqueia fornecedor.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ErroApi } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { CabecalhoPagina } from '../componentes/Cabecalho';
import {
  Aviso, Cartao, Entrada, Etiqueta, Indicador, Modal, Selecao, Vazio,
  dataHora, moeda, numero,
} from '../componentes/ui';

type Aba = 'decisao' | 'recomendacoes' | 'riscos' | 'perguntar' | 'simular' | 'governanca';
type Tom = 'perigo' | 'alerta' | 'info' | 'acento' | 'neutro';

const TOM_PRIORIDADE: Record<string, Tom> = {
  CRITICO: 'perigo', ALTO: 'perigo', MEDIO: 'alerta', BAIXO: 'info',
};

const TOM_NIVEL: Record<string, Tom> = {
  CRITICO: 'perigo', ALTO: 'perigo', MODERADO: 'alerta', BAIXO: 'acento',
};

const TOM_CONFIANCA: Record<string, Tom> = {
  ALTA: 'acento', MEDIA: 'alerta', BAIXA: 'perigo', INSUFICIENTE: 'neutro',
};

/** Secao 47: a natureza da afirmacao e visivel, nao implicita. */
const TOM_NATUREZA: Record<string, Tom> = {
  FATO: 'acento', CALCULO: 'info', PREVISAO: 'alerta',
  HIPOTESE: 'neutro', RECOMENDACAO: 'info', SIMULACAO: 'alerta',
};

const TOM_STATUS: Record<string, Tom> = {
  NOVA: 'alerta', EM_ANALISE: 'info', ACEITA: 'acento',
  REJEITADA: 'neutro', EXECUTADA: 'acento', EXPIRADA: 'neutro',
};

const erroDe = (e: unknown, padrao: string) =>
  (e instanceof ErroApi ? e.message : padrao);

export function Ia() {
  const { pode } = useAuth();
  const podeExecutivo = pode('ia.executivo');
  const [aba, setAba] = useState<Aba>(podeExecutivo ? 'decisao' : 'recomendacoes');

  const abas: Array<{ id: Aba; texto: string; visivel: boolean }> = [
    { id: 'decisao', texto: 'Central de Decisao', visivel: podeExecutivo },
    { id: 'recomendacoes', texto: 'Recomendacoes', visivel: pode('ia.ler') },
    { id: 'riscos', texto: 'Riscos', visivel: pode('ia.ler') },
    { id: 'perguntar', texto: 'Pergunte aos Dados', visivel: pode('ia.perguntar') },
    { id: 'simular', texto: 'Simulacoes', visivel: pode('ia.simular') },
    { id: 'governanca', texto: 'Governanca', visivel: pode('ia.ler') },
  ];

  return (
    <>
      <CabecalhoPagina
        titulo="Inteligencia artificial"
        descricao="Camada de analise sobre os modulos 01 a 11. A IA analisa, preve, alerta
          e recomenda; quem decide e executa e voce, no modulo que tem a alcada."
      />

      <nav className="abas">
        {abas.filter((a) => a.visivel).map((a) => (
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

      {aba === 'decisao' && <CentralDecisao />}
      {aba === 'recomendacoes' && <Recomendacoes />}
      {aba === 'riscos' && <Riscos />}
      {aba === 'perguntar' && <Perguntar />}
      {aba === 'simular' && <Simular />}
      {aba === 'governanca' && <Governanca />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Evidencias (secoes 46 e 47)
// ---------------------------------------------------------------------------

function ListaEvidencias({ evidencias }: { evidencias: any[] }) {
  if (!evidencias?.length) return <p className="fraco">Sem evidencias registradas.</p>;
  return (
    <ul className="lista-evidencias">
      {evidencias.map((e, i) => (
        <li key={i}>
          <Etiqueta texto={e.natureza} tom={TOM_NATUREZA[e.natureza] ?? 'neutro'} />
          <span className="evidencia__texto">{e.afirmacao}</span>
          <span className="fraco"> — {e.fonte}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Central de Decisao (secoes 30 e 44)
// ---------------------------------------------------------------------------

function CentralDecisao() {
  const navegar = useNavigate();
  const [dados, setDados] = useState<any>(null);
  const [resumo, setResumo] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aberto, setAberto] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [d, r] = await Promise.all([
          api<any>('/ia/central-decisao'),
          api<any>('/ia/resumo-diario'),
        ]);
        setDados(d.data);
        setResumo(r.data);
      } catch (e) {
        setErro(erroDe(e, 'Falha ao montar a Central de Decisao'));
      }
    })();
  }, []);

  if (erro) return <Cartao><Aviso>{erro}</Aviso></Cartao>;
  if (!dados) return <Cartao><Vazio>Analisando os dados de hoje…</Vazio></Cartao>;

  const faixa = (titulo: string, itens: string[], tom: Tom) => (
    <Cartao titulo={titulo}>
      {itens.length === 0
        ? <p className="fraco">Nada nesta faixa hoje.</p>
        : (
          <ul className="lista-causas">
            {itens.map((i, n) => (
              <li key={n}><Etiqueta texto="•" tom={tom} /> {i}</li>
            ))}
          </ul>
        )}
    </Cartao>
  );

  return (
    <>
      <Cartao
        titulo={`Resumo de ${dados.data}`}
        acoes={<span className="fraco">perfil {dados.perfil} · {dataHora(dados.apurado_em)}</span>}
      >
        <div className="grade-indicadores">
          {(resumo?.indicadores ?? []).map((i: any) => (
            <Indicador
              key={i.codigo}
              rotulo={i.nome}
              valor={i.calculavel
                ? (i.unidade === 'MOEDA' ? moeda(i.valor)
                  : i.unidade === 'PERCENTUAL' ? `${numero(i.valor, 2)}%`
                    : numero(i.valor, 2))
                : <span className="fraco">sem dados</span>}
              nota={i.calculavel ? i.fonte : i.motivo}
              tom={i.semaforo === 'VERDE' ? 'acento' : i.semaforo === 'VERMELHO' ? 'perigo'
                : i.semaforo === 'AMARELO' ? 'alerta' : 'neutro'}
            />
          ))}
        </div>
      </Cartao>

      {resumo && (
        <div className="colunas-tres">
          {faixa('Exige acao imediata', resumo.critico.itens, 'perigo')}
          {faixa('Pode gerar impacto', resumo.atencao.itens, 'alerta')}
          {faixa('Oportunidades', resumo.oportunidades.itens, 'acento')}
        </div>
      )}

      <Cartao titulo="As dez perguntas do dia">
        <p className="fraco">{dados.observacao}</p>
        <div className="tabela-rolagem">
          <table className="tabela">
            <thead>
              <tr><th>Pergunta</th><th>Resposta</th><th>Qtd</th><th>Valor</th><th /></tr>
            </thead>
            <tbody>
              {dados.blocos.map((b: any) => (
                <tr key={b.pergunta}>
                  <td><strong>{b.pergunta}</strong></td>
                  <td>
                    {b.resposta}
                    {b.limitacao && <div className="fraco">⚠ {b.limitacao}</div>}
                  </td>
                  <td className="num">{b.quantidade}</td>
                  <td className="num">{b.valor === null ? '—' : moeda(b.valor)}</td>
                  <td>
                    {b.itens.length > 0 && (
                      <button
                        type="button"
                        className="botao botao--pequeno botao--fantasma"
                        onClick={() => setAberto(b.pergunta)}
                      >
                        Detalhar
                      </button>
                    )}
                    {b.drilldown && (
                      <button
                        type="button"
                        className="botao botao--pequeno botao--fantasma"
                        onClick={() => navegar('/indicadores')}
                      >
                        Indicadores
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Cartao>

      {aberto && (
        <DetalheBloco
          bloco={dados.blocos.find((b: any) => b.pergunta === aberto)}
          aoFechar={() => setAberto(null)}
        />
      )}
    </>
  );
}

function DetalheBloco({ bloco, aoFechar }: { bloco: any; aoFechar: () => void }) {
  if (!bloco) return null;
  const campos = Object.keys(bloco.itens[0] ?? {}).slice(0, 8);

  return (
    <Modal titulo={bloco.pergunta} aoFechar={aoFechar} largo>
      <p>{bloco.resposta}</p>
      {bloco.limitacao && <Aviso tipo="erro">{bloco.limitacao}</Aviso>}

      <Cartao titulo="Evidencias">
        <ListaEvidencias evidencias={bloco.evidencias} />
      </Cartao>

      <div className="tabela-rolagem">
        <table className="tabela">
          <thead>
            <tr>{campos.map((c) => <th key={c}>{c.replace(/_/g, ' ')}</th>)}</tr>
          </thead>
          <tbody>
            {bloco.itens.slice(0, 50).map((it: any, i: number) => (
              <tr key={i}>
                {campos.map((c) => (
                  <td key={c}>
                    {it[c] === null || it[c] === undefined
                      ? <span className="fraco">—</span>
                      : typeof it[c] === 'object'
                        ? <span className="fraco">{JSON.stringify(it[c]).slice(0, 60)}</span>
                        : String(it[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Recomendacoes (secoes 20, 21, 36 e 46)
// ---------------------------------------------------------------------------

function Recomendacoes() {
  const { pode } = useAuth();
  const [lista, setLista] = useState<any>(null);
  const [resumo, setResumo] = useState<any>(null);
  const [status, setStatus] = useState('NOVA');
  const [erro, setErro] = useState<string | null>(null);
  const [aberta, setAberta] = useState<number | null>(null);
  const [gerando, setGerando] = useState(false);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    void (async () => {
      try {
        const [l, r] = await Promise.all([
          api<any>('/ia/recommendations', { query: { status, limite: 50 } }),
          api<any>('/ia/recommendations/resumo'),
        ]);
        setLista(l.data);
        setResumo(r.data);
        setErro(null);
      } catch (e) {
        setErro(erroDe(e, 'Falha ao carregar as recomendacoes'));
      }
    })();
  }, [status, recarga]);

  const gerar = async () => {
    setGerando(true);
    try {
      await api('/ia/recommendations/gerar', {
        metodo: 'POST', corpo: { limite_produtos: 150 },
      });
      setRecarga((r) => r + 1);
    } catch (e) {
      setErro(erroDe(e, 'Falha ao gerar recomendacoes'));
    } finally {
      setGerando(false);
    }
  };

  return (
    <>
      {erro && <Aviso>{erro}</Aviso>}

      {resumo && (
        <Cartao titulo="Central de recomendacoes">
          <div className="grade-indicadores">
            {['CRITICO', 'ALTO', 'MEDIO', 'BAIXO'].map((p) => (
              <Indicador
                key={p}
                rotulo={p}
                valor={resumo.por_prioridade[p] ?? 0}
                nota="Em aberto"
                tom={TOM_PRIORIDADE[p]}
              />
            ))}
            <Indicador
              rotulo="Impacto em aberto"
              valor={moeda(resumo.impacto_em_aberto)}
              nota="Soma do impacto estimado das recomendacoes pendentes"
            />
          </div>
        </Cartao>
      )}

      <Cartao
        titulo="Recomendacoes"
        acoes={pode('ia.decidir') ? (
          <button
            type="button"
            className="botao botao--fantasma botao--pequeno"
            disabled={gerando}
            onClick={() => void gerar()}
          >
            {gerando ? 'Analisando…' : 'Analisar agora'}
          </button>
        ) : undefined}
      >
        <div className="filtros">
          <Selecao
            rotulo="Situacao"
            valor={status}
            aoMudar={setStatus}
            opcoes={['NOVA', 'EM_ANALISE', 'ACEITA', 'REJEITADA', 'EXECUTADA', 'EXPIRADA']
              .map((s) => ({ valor: s, texto: s.replace(/_/g, ' ') }))}
            vazio={null}
          />
        </div>

        <p className="fraco">
          A IA recomenda e explica. Aceitar registra a decisao; a execucao continua
          no modulo operacional, com a sua alcada.
        </p>

        {!lista ? <Vazio>Carregando…</Vazio>
          : lista.recomendacoes.length === 0
            ? <Vazio>Nenhuma recomendacao nesta situacao.</Vazio>
            : (
              <div className="tabela-rolagem">
                <table className="tabela">
                  <thead>
                    <tr>
                      <th>Prioridade</th><th>Recomendacao</th><th>Tipo</th>
                      <th>Confianca</th><th>Impacto</th><th>Urgencia</th>
                      <th>Situacao</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {lista.recomendacoes.map((r: any) => (
                      <tr key={r.id}>
                        <td>
                          <Etiqueta texto={r.prioridade} tom={TOM_PRIORIDADE[r.prioridade]} />
                          <div className="fraco">{numero(r.score_prioridade, 1)}</div>
                        </td>
                        <td>
                          <strong>{r.titulo}</strong>
                          <div className="fraco">{r.problema}</div>
                        </td>
                        <td><Etiqueta texto={r.tipo} /></td>
                        <td>
                          <Etiqueta texto={r.confianca} tom={TOM_CONFIANCA[r.confianca]} />
                        </td>
                        <td className="num">
                          {r.impacto_estimado === null
                            ? <span className="fraco">—</span>
                            : moeda(r.impacto_estimado)}
                        </td>
                        <td className="num">
                          {r.urgencia_dias === null
                            ? <span className="fraco">—</span>
                            : `${r.urgencia_dias}d`}
                        </td>
                        <td><Etiqueta texto={r.status} tom={TOM_STATUS[r.status]} /></td>
                        <td>
                          <button
                            type="button"
                            className="botao botao--pequeno botao--fantasma"
                            onClick={() => setAberta(r.id)}
                          >
                            Ver evidencias
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
      </Cartao>

      {aberta !== null && (
        <DetalheRecomendacao
          id={aberta}
          aoFechar={() => setAberta(null)}
          aoDecidir={() => { setAberta(null); setRecarga((r) => r + 1); }}
        />
      )}
    </>
  );
}

function DetalheRecomendacao({ id, aoFechar, aoDecidir }: {
  id: number; aoFechar: () => void; aoDecidir: () => void;
}) {
  const { pode } = useAuth();
  const navegar = useNavigate();
  const [r, setR] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [motivo, setMotivo] = useState('');
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const { data } = await api<any>(`/ia/recommendations/${id}`);
        setR(data);
      } catch (e) {
        setErro(erroDe(e, 'Falha ao abrir a recomendacao'));
      }
    })();
  }, [id]);

  const decidir = async (tipo: string) => {
    setSalvando(true);
    try {
      await api(`/ia/recommendations/${id}/feedback`, {
        metodo: 'POST',
        corpo: { tipo, motivo: motivo || undefined },
      });
      aoDecidir();
    } catch (e) {
      setErro(erroDe(e, 'Falha ao registrar a decisao'));
      setSalvando(false);
    }
  };

  const aberta = r?.status === 'NOVA' || r?.status === 'EM_ANALISE';
  const explicacao = r?.explicacao ?? {};

  const PERGUNTAS: Array<[string, string]> = [
    ['O que aconteceu?', explicacao.o_que_aconteceu],
    ['Por que aconteceu?', explicacao.por_que_aconteceu],
    ['Qual o impacto?', explicacao.qual_o_impacto],
    ['O que pode acontecer?', explicacao.o_que_pode_acontecer],
    ['O que recomendo?', explicacao.o_que_recomendo],
  ];

  return (
    <Modal
      titulo={r?.titulo ?? 'Recomendacao'}
      aoFechar={aoFechar}
      largo
      rodape={aberta && pode('ia.decidir') ? (
        <>
          <button
            type="button"
            className="botao botao--fantasma"
            disabled={salvando}
            onClick={() => void decidir('REJEITAR')}
          >
            Rejeitar
          </button>
          <button
            type="button"
            className="botao botao--fantasma"
            disabled={salvando}
            onClick={() => void decidir('AJUSTAR')}
          >
            Em analise
          </button>
          <button
            type="button"
            className="botao botao--primario"
            disabled={salvando}
            onClick={() => void decidir('ACEITAR')}
          >
            Aceitar
          </button>
        </>
      ) : undefined}
    >
      {erro && <Aviso>{erro}</Aviso>}
      {!r && !erro && <Vazio>Carregando…</Vazio>}

      {r && (
        <>
          <div className="grade-indicadores">
            <Indicador rotulo="Prioridade" valor={r.prioridade}
              nota={`score ${numero(r.score_prioridade, 1)}`}
              tom={TOM_PRIORIDADE[r.prioridade]} />
            <Indicador rotulo="Confianca" valor={r.confianca}
              nota="Baseada em volume, estabilidade e atualidade dos dados"
              tom={TOM_CONFIANCA[r.confianca]} />
            <Indicador
              rotulo="Impacto estimado"
              valor={r.impacto_estimado === null ? '—' : moeda(r.impacto_estimado)}
              nota={r.impacto_descricao}
            />
            {r.ocorrencias > 1 && (
              <Indicador rotulo="Reincidencia" valor={`${r.ocorrencias}x`}
                nota="A condicao voltou a ocorrer sem ter sido tratada" tom="alerta" />
            )}
          </div>

          {/* Secao 21: as seis perguntas */}
          <Cartao titulo="Explicacao">
            <dl className="definicoes">
              {PERGUNTAS.filter(([, v]) => !!v).map(([p, v]) => (
                <div key={p} style={{ display: 'contents' }}>
                  <dt>{p}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
              <dt>Quais dados usei?</dt>
              <dd>
                <ul className="lista-causas">
                  {(explicacao.quais_dados_foram_utilizados ?? []).map((d: string, i: number) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              </dd>
            </dl>
          </Cartao>

          {/* Secao 47: natureza de cada afirmacao */}
          <Cartao titulo="Evidencias">
            <ListaEvidencias evidencias={r.evidencias} />
          </Cartao>

          <Cartao titulo="A conta">
            <p className="fraco">
              Congelada como foi feita no momento da analise — recalcular hoje daria
              outro numero e deixaria de explicar a decisao que foi tomada.
            </p>
            <pre className="bloco-codigo">{JSON.stringify(r.calculo, null, 2)}</pre>
          </Cartao>

          {(r.premissas ?? []).length > 0 && (
            <Cartao titulo="Premissas">
              <ul className="lista-causas">
                {r.premissas.map((p: string, i: number) => <li key={i}>{p}</li>)}
              </ul>
            </Cartao>
          )}

          {(r.feedback ?? []).length > 0 && (
            <Cartao titulo="Historico de decisao">
              <div className="tabela-rolagem">
                <table className="tabela">
                  <thead>
                    <tr><th>Quando</th><th>Decisao</th><th>Usuario</th><th>Motivo</th></tr>
                  </thead>
                  <tbody>
                    {r.feedback.map((f: any) => (
                      <tr key={f.id}>
                        <td>{dataHora(f.created_at)}</td>
                        <td><Etiqueta texto={f.tipo} /></td>
                        <td>{f.usuario ?? '—'}</td>
                        <td className="fraco">{f.motivo ?? f.observacao ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Cartao>
          )}

          {aberta && pode('ia.decidir') && (
            <div className="campo">
              <label htmlFor="motivo">Motivo (obrigatorio ao rejeitar)</label>
              <textarea
                id="motivo"
                rows={2}
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Por que esta recomendacao nao se aplica"
              />
            </div>
          )}

          {r.produto_id && (
            <div className="acoes">
              <button type="button" className="botao botao--fantasma"
                onClick={() => { aoFechar(); navegar('/estoque'); }}>
                Ver estoque
              </button>
              <button type="button" className="botao botao--fantasma"
                onClick={() => { aoFechar(); navegar('/compras'); }}>
                Abrir planejamento de compras
              </button>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Riscos (secoes 17 e 18)
// ---------------------------------------------------------------------------

function Riscos() {
  const [dados, setDados] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { data } = await api<any>('/ia/risks', { query: { limite: 60 } });
        setDados(data);
      } catch (e) {
        setErro(erroDe(e, 'Falha ao carregar a central de riscos'));
      }
    })();
  }, []);

  if (erro) return <Cartao><Aviso>{erro}</Aviso></Cartao>;
  if (!dados) return <Cartao><Vazio>Avaliando riscos…</Vazio></Cartao>;

  return (
    <Cartao titulo="Central de riscos">
      <div className="grade-indicadores">
        {['CRITICO', 'ALTO', 'MODERADO'].map((n) => (
          <Indicador key={n} rotulo={n} valor={dados.por_nivel[n] ?? 0}
            tom={TOM_NIVEL[n]} />
        ))}
        <Indicador rotulo="Produtos avaliados" valor={dados.avaliados} />
      </div>

      <p className="fraco">{dados.metodologia}</p>

      <div className="tabela-rolagem">
        <table className="tabela">
          <thead>
            <tr>
              <th>Produto</th><th>Tipo</th><th>Nivel</th><th>Prob.</th><th>Impacto</th>
              <th>Ruptura</th><th>Impacto/dia</th><th>Fatores observados</th>
            </tr>
          </thead>
          <tbody>
            {dados.riscos.map((r: any) => (
              <tr key={r.produto_id}>
                <td>
                  <strong>{r.descricao}</strong>
                  <div className="fraco">{r.codigo}</div>
                </td>
                <td><Etiqueta texto={r.tipo} /></td>
                <td><Etiqueta texto={r.risco.nivel} tom={TOM_NIVEL[r.risco.nivel]} /></td>
                <td className="num">{r.risco.probabilidade}</td>
                <td className="num">{r.risco.impacto}</td>
                <td className="num">
                  {r.dias_ate_ruptura === null
                    ? <span className="fraco">—</span>
                    : `${r.dias_ate_ruptura}d`}
                </td>
                <td className="num">{moeda(r.impacto_diario)}</td>
                <td className="fraco">
                  <ul className="lista-causas">
                    {r.risco.fatores.map((f: any, i: number) => (
                      <li key={i}>
                        {f.descricao} <em>({f.dimensao.toLowerCase()}, {f.peso} pts)</em>
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {dados.riscos.length === 0 && <Vazio>Nenhum risco acima de BAIXO.</Vazio>}
    </Cartao>
  );
}

// ---------------------------------------------------------------------------
// Pergunte aos Dados (secoes 22 e 25)
// ---------------------------------------------------------------------------

function Perguntar() {
  const [pergunta, setPergunta] = useState('');
  const [resposta, setResposta] = useState<any>(null);
  const [exemplos, setExemplos] = useState<any[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const { data } = await api<any[]>('/ia/exemplos');
        setExemplos(data ?? []);
      } catch { /* os exemplos sao um apoio, nao um requisito */ }
    })();
  }, []);

  const perguntar = async (texto: string) => {
    if (!texto.trim()) return;
    setCarregando(true);
    setPergunta(texto);
    try {
      const { data } = await api<any>('/ia/chat', {
        metodo: 'POST', corpo: { pergunta: texto },
      });
      setResposta(data);
      setErro(null);
    } catch (e) {
      setErro(erroDe(e, 'Falha ao responder'));
    } finally {
      setCarregando(false);
    }
  };

  const celula = (valor: unknown, tipo: string) => {
    if (valor === null || valor === undefined) return <span className="fraco">—</span>;
    switch (tipo) {
      case 'moeda': return <span className="num">{moeda(valor)}</span>;
      case 'numero': return <span className="num">{numero(valor, 2)}</span>;
      case 'percentual': return <span className="num">{numero(valor, 2)}%</span>;
      case 'etiqueta': return <Etiqueta texto={String(valor)} />;
      default: return String(valor);
    }
  };

  return (
    <>
      <Cartao titulo="Pergunte aos dados">
        <p className="fraco">
          Pergunte em portugues. A pergunta escolhe uma consulta do catalogo e
          preenche os parametros — o texto nunca vira SQL.
        </p>
        <div className="filtros">
          <Entrada
            rotulo="Sua pergunta"
            valor={pergunta}
            aoMudar={setPergunta}
            placeholder="Quais produtos podem romper?"
            className="campo--busca"
          />
          <button
            type="button"
            className="botao botao--primario"
            style={{ alignSelf: 'flex-end' }}
            disabled={carregando}
            onClick={() => void perguntar(pergunta)}
          >
            {carregando ? 'Consultando…' : 'Perguntar'}
          </button>
        </div>

        <div className="acoes">
          {exemplos.slice(0, 8).map((e) => (
            <button
              key={e.codigo}
              type="button"
              className="botao botao--fantasma botao--pequeno"
              onClick={() => void perguntar(e.perguntas[0])}
            >
              {e.perguntas[0]}
            </button>
          ))}
        </div>
      </Cartao>

      {erro && <Aviso>{erro}</Aviso>}

      {resposta && (
        <Cartao
          titulo={resposta.titulo ?? 'Resposta'}
          acoes={resposta.confianca_intencao && (
            <Etiqueta texto={`intencao ${resposta.confianca_intencao}`}
              tom={TOM_CONFIANCA[resposta.confianca_intencao]} />
          )}
        >
          <p><strong>{resposta.resposta}</strong></p>

          {!resposta.entendida && resposta.alternativas?.length > 0 && (
            <>
              <p className="fraco">Talvez voce queira perguntar:</p>
              <div className="acoes">
                {resposta.alternativas.map((a: any) => (
                  <button
                    key={a.codigo}
                    type="button"
                    className="botao botao--fantasma botao--pequeno"
                    onClick={() => void perguntar(a.exemplo)}
                  >
                    {a.exemplo}
                  </button>
                ))}
              </div>
            </>
          )}

          {resposta.linhas?.length > 0 && (
            <div className="tabela-rolagem">
              <table className="tabela">
                <thead>
                  <tr>{resposta.colunas.map((c: any) => <th key={c.campo}>{c.titulo}</th>)}</tr>
                </thead>
                <tbody>
                  {resposta.linhas.slice(0, 100).map((l: any, i: number) => (
                    <tr key={i}>
                      {resposta.colunas.map((c: any) => (
                        <td key={c.campo}>{celula(l[c.campo], c.tipo)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {resposta.fonte && (
            <p className="fraco">
              Fonte: {resposta.fonte} · {resposta.total} registro(s) · {resposta.tempo_ms}ms
            </p>
          )}
          {resposta.camadas_seguranca?.length > 0 && (
            <p className="fraco">
              Camadas de seguranca aplicadas: {resposta.camadas_seguranca.join(' · ')}
            </p>
          )}
        </Cartao>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Simulacoes (secoes 28 e 29)
// ---------------------------------------------------------------------------

function Simular() {
  const [cenarios, setCenarios] = useState<any[]>([]);
  const [escolhido, setEscolhido] = useState('AUMENTO_DEMANDA');
  const [resultado, setResultado] = useState<any>(null);
  const [comparacao, setComparacao] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [rodando, setRodando] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const { data } = await api<any[]>('/ia/cenarios');
        setCenarios(data ?? []);
      } catch (e) {
        setErro(erroDe(e, 'Falha ao carregar os cenarios'));
      }
    })();
  }, []);

  const rodar = async () => {
    setRodando(true);
    try {
      const { data } = await api<any>('/ia/simulate', {
        metodo: 'POST',
        corpo: { nome: `Simulacao ${escolhido} ${new Date().toISOString().slice(0, 16)}`,
          cenario: escolhido },
      });
      setResultado(data);
      setErro(null);
    } catch (e) {
      setErro(erroDe(e, 'Falha ao simular'));
    } finally {
      setRodando(false);
    }
  };

  const comparar = async () => {
    setRodando(true);
    try {
      const { data } = await api<any>('/ia/simulate/comparar', {
        metodo: 'POST', corpo: { cenarios: 'BASE,OTIMISTA,PESSIMISTA,RUPTURA' },
      });
      setComparacao(data);
      setErro(null);
    } catch (e) {
      setErro(erroDe(e, 'Falha ao comparar cenarios'));
    } finally {
      setRodando(false);
    }
  };

  const atual = cenarios.find((c) => c.codigo === escolhido);

  return (
    <>
      {erro && <Aviso>{erro}</Aviso>}

      <Cartao titulo="Simulacao de cenarios">
        <p className="fraco">
          Cenario hipotetico sobre o mesmo calculo do planejamento oficial. Nenhum
          dado operacional e alterado.
        </p>
        <div className="filtros">
          <Selecao
            rotulo="Cenario"
            valor={escolhido}
            aoMudar={setEscolhido}
            opcoes={cenarios.map((c) => ({ valor: c.codigo, texto: c.titulo }))}
            vazio={null}
          />
          <button type="button" className="botao botao--primario"
            style={{ alignSelf: 'flex-end' }} disabled={rodando}
            onClick={() => void rodar()}>
            {rodando ? 'Simulando…' : 'Simular'}
          </button>
          <button type="button" className="botao botao--fantasma"
            style={{ alignSelf: 'flex-end' }} disabled={rodando}
            onClick={() => void comparar()}>
            Comparar quatro cenarios
          </button>
        </div>
        {atual && (
          <p className="fraco">
            {atual.descricao} · demanda {atual.fatores.demanda}% · lead time
            {' '}+{atual.fatores.lead_time}d · seguranca {atual.fatores.seguranca}%
            {' '}· preco {atual.fatores.preco}% · cambio {atual.fatores.cambio}%
          </p>
        )}
      </Cartao>

      {resultado && (
        <Cartao titulo={resultado.titulo}>
          <div className="grade-indicadores">
            <Indicador rotulo="Itens com necessidade"
              valor={resultado.reposicao.itens_com_necessidade} />
            <Indicador rotulo="Quantidade total"
              valor={numero(resultado.reposicao.quantidade_total, 0)} />
            <Indicador rotulo="Valor simulado"
              valor={moeda(resultado.financeiro.valorSimulado)}
              nota={resultado.financeiro.diferencaPercentual !== null
                ? `${numero(resultado.financeiro.diferencaPercentual, 2)}% sobre o valor base`
                : undefined}
              tom="alerta" />
            <Indicador rotulo="Risco de ruptura"
              valor={resultado.reposicao.produtos_risco_ruptura} tom="perigo" />
            <Indicador rotulo="Em excesso"
              valor={resultado.reposicao.produtos_excesso} />
            {resultado.comparacao_com_base && (
              <Indicador
                rotulo="Diferenca para o base"
                valor={moeda(resultado.comparacao_com_base.diferenca_valor)}
                nota={resultado.comparacao_com_base.diferenca_percentual !== null
                  ? `${numero(resultado.comparacao_com_base.diferenca_percentual, 2)}%`
                  : undefined}
              />
            )}
          </div>

          <Cartao titulo="Efeito de cada fator">
            <div className="tabela-rolagem">
              <table className="tabela">
                <thead><tr><th>Fator</th><th>De</th><th>Para</th><th>Efeito</th></tr></thead>
                <tbody>
                  {resultado.financeiro.fatores.map((f: any) => (
                    <tr key={f.fator}>
                      <td>{f.fator}</td>
                      <td className="num">{moeda(f.de)}</td>
                      <td className="num">{moeda(f.para)}</td>
                      <td className="num">{moeda(f.efeito)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="fraco">
              Preco e cambio se multiplicam: 10% mais 10% dao 21%, nao 20%.
            </p>
          </Cartao>

          <Cartao titulo="Evidencias">
            <ListaEvidencias evidencias={resultado.evidencias} />
          </Cartao>

          <Aviso tipo="ok">{resultado.aviso}</Aviso>
        </Cartao>
      )}

      {comparacao && (
        <Cartao titulo="Comparacao de cenarios">
          <div className="tabela-rolagem">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Cenario</th><th>Itens</th><th>Quantidade</th><th>Valor</th>
                  <th>Ruptura</th><th>Excesso</th><th>Dif. para base</th>
                </tr>
              </thead>
              <tbody>
                {comparacao.cenarios.map((c: any) => (
                  <tr key={c.cenario}>
                    <td><strong>{c.titulo}</strong></td>
                    <td className="num">{c.itens_com_necessidade}</td>
                    <td className="num">{numero(c.quantidade_total, 0)}</td>
                    <td className="num">{moeda(c.valor_simulado)}</td>
                    <td className="num">{c.produtos_risco_ruptura}</td>
                    <td className="num">{c.produtos_excesso}</td>
                    <td className="num">
                      {c.diferenca_para_base === null ? '—' : moeda(c.diferenca_para_base)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="fraco">{comparacao.aviso}</p>
        </Cartao>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Governanca (secoes 37 e 39)
// ---------------------------------------------------------------------------

function Governanca() {
  const { pode } = useAuth();
  const [seguranca, setSeguranca] = useState<any>(null);
  const [config, setConfig] = useState<any>(null);
  const [qualidade, setQualidade] = useState<any>(null);
  const [historico, setHistorico] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [s, c, q, h] = await Promise.all([
          api<any>('/ia/seguranca'),
          api<any>('/ia/config'),
          api<any>('/ia/qualidade-dados'),
          api<any>('/ia/history', { query: { limite: 15 } }),
        ]);
        setSeguranca(s.data);
        setConfig(c.data);
        setQualidade(q.data);
        setHistorico(h.data);
      } catch (e) {
        setErro(erroDe(e, 'Falha ao carregar a governanca'));
      }
    })();
  }, []);

  if (erro) return <Cartao><Aviso>{erro}</Aviso></Cartao>;
  if (!seguranca) return <Cartao><Vazio>Carregando…</Vazio></Cartao>;

  return (
    <>
      <Cartao titulo="Camadas de seguranca">
        <p className="fraco">
          O autoteste tenta uma escrita real dentro da transacao somente leitura.
          Se o banco recusar, a camada esta funcionando — e a tela mostra o codigo
          do erro, nao apenas uma afirmacao.
        </p>
        <div className="grade-indicadores">
          <Indicador
            rotulo="Autoteste de escrita"
            valor={seguranca.autoteste?.protegido ? 'Bloqueada' : 'PASSOU'}
            nota={seguranca.autoteste?.mensagem}
            tom={seguranca.autoteste?.protegido ? 'acento' : 'perigo'}
          />
          <Indicador rotulo="Comandos bloqueados"
            valor={seguranca.comandos_bloqueados?.length ?? 0} />
          <Indicador rotulo="Tabelas legiveis"
            valor={seguranca.tabelas_permitidas ?? 0}
            nota="Lista de permissao: o que nao esta nela nao e legivel" />
        </div>

        <div className="tabela-rolagem">
          <table className="tabela">
            <thead><tr><th>Camada</th><th>Ativa</th><th>O que faz</th></tr></thead>
            <tbody>
              {seguranca.camadas.map((c: any) => (
                <tr key={c.nome}>
                  <td><strong>{c.nome}</strong></td>
                  <td>
                    <Etiqueta texto={c.ativa ? 'ATIVA' : 'INATIVA'}
                      tom={c.ativa ? 'acento' : 'alerta'} />
                  </td>
                  <td className="fraco">{c.descricao}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Cartao>

      {qualidade && (
        <Cartao titulo="Qualidade dos dados">
          <p className="fraco">{qualidade.observacao}</p>
          <div className="tabela-rolagem">
            <table className="tabela">
              <thead>
                <tr><th>Lacuna</th><th>Produtos</th><th>%</th><th>Efeito sobre a analise</th></tr>
              </thead>
              <tbody>
                {qualidade.lacunas.map((l: any) => (
                  <tr key={l.codigo}>
                    <td><Etiqueta texto={l.codigo} tom="alerta" /></td>
                    <td className="num">{l.produtos}</td>
                    <td className="num">{numero(l.percentual, 1)}%</td>
                    <td className="fraco">{l.efeito}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {qualidade.lacunas.length === 0 && <Vazio>Nenhuma lacuna relevante.</Vazio>}
        </Cartao>
      )}

      {config && (
        <Cartao titulo="Parametros da IA">
          <p className="fraco">{config.observacao}</p>
          <div className="tabela-rolagem">
            <table className="tabela">
              <thead><tr><th>Parametro</th><th>Valor</th><th>Para que serve</th></tr></thead>
              <tbody>
                {config.configuracoes.map((c: any) => (
                  <tr key={c.chave}>
                    <td><code>{c.chave}</code></td>
                    <td className="num">{c.valor}</td>
                    <td className="fraco">{c.descricao}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!pode('ia.configurar') && (
            <p className="fraco">Alterar parametros exige a permissao ia.configurar.</p>
          )}
        </Cartao>
      )}

      {historico && (
        <Cartao titulo="Historico de execucoes">
          <p className="fraco">
            Toda consulta fica registrada, inclusive as bloqueadas — a tabela e
            append-only.
          </p>
          <div className="tabela-rolagem">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Quando</th><th>Tipo</th><th>Entrada</th><th>Intencao</th>
                  <th>Situacao</th><th>Linhas</th><th>Tempo</th><th>Usuario</th>
                </tr>
              </thead>
              <tbody>
                {historico.execucoes.map((e: any) => (
                  <tr key={e.id}>
                    <td>{dataHora(e.created_at)}</td>
                    <td><Etiqueta texto={e.tipo} /></td>
                    <td className="fraco">{String(e.entrada).slice(0, 60)}</td>
                    <td>{e.intencao ?? <span className="fraco">—</span>}</td>
                    <td>
                      <Etiqueta
                        texto={e.status}
                        tom={e.status === 'OK' ? 'acento'
                          : e.status === 'BLOQUEADA' ? 'perigo' : 'alerta'}
                      />
                      {e.motivo_bloqueio && (
                        <div className="fraco">{e.motivo_bloqueio}</div>
                      )}
                    </td>
                    <td className="num">{e.linhas ?? '—'}</td>
                    <td className="num">{e.tempo_ms ? `${e.tempo_ms}ms` : '—'}</td>
                    <td>{e.usuario ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Cartao>
      )}
    </>
  );
}
