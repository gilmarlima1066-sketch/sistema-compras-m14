/**
 * Modulo 13 - centro de operacoes.
 *
 * Esta tela responde uma pergunta so: a automacao esta funcionando?
 *
 * O diagnostico vem primeiro, antes dos numeros, porque automacao quebra em
 * silencio. O alerta que nao chegou nao aparece em lugar nenhum; o job que
 * parou de rodar nao gera linha. Um painel que so mostra o que aconteceu daria
 * luz verde para um sistema parado - e por isso cada sintoma aqui vem com a
 * acao correspondente, nao so com o numero.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ErroApi } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { CabecalhoPagina } from '../componentes/Cabecalho';
import { GraficoLinha } from '../componentes/graficos';
import {
  Aviso, Cartao, Entrada, Etiqueta, Indicador, Modal, Selecao, Vazio,
  dataHora, numero,
} from '../componentes/ui';

type Aba = 'saude' | 'jobs' | 'fila' | 'eventos' | 'regras' | 'integracoes' | 'parametros';
type Tom = 'perigo' | 'alerta' | 'info' | 'acento' | 'neutro';

const TOM_GRAVIDADE: Record<string, Tom> = {
  CRITICO: 'perigo', ATENCAO: 'alerta', OK: 'acento',
};

const TOM_STATUS_JOB: Record<string, Tom> = {
  OCIOSO: 'acento', EXECUTANDO: 'info', ERRO: 'perigo', DESATIVADO: 'neutro',
};

const TOM_STATUS_FILA: Record<string, Tom> = {
  PENDENTE: 'alerta', PROCESSANDO: 'info', CONCLUIDO: 'acento',
  ERRO: 'perigo', RETRY: 'alerta', CANCELADO: 'neutro',
};

const TOM_WEBHOOK: Record<string, Tom> = {
  PROCESSADO: 'acento', RECEBIDO: 'info', DUPLICADO: 'neutro',
  REJEITADO: 'perigo', ERRO: 'perigo',
};

const erroDe = (e: unknown, padrao: string) =>
  (e instanceof ErroApi ? e.message : padrao);

export function Operacao() {
  const { pode } = useAuth();
  const [aba, setAba] = useState<Aba>('saude');

  const abas: Array<{ id: Aba; texto: string; visivel: boolean }> = [
    { id: 'saude', texto: 'Saude', visivel: pode('automacao.operacao') },
    { id: 'jobs', texto: 'Jobs', visivel: pode('automacao.ler') },
    { id: 'fila', texto: 'Fila', visivel: pode('automacao.ler') },
    { id: 'eventos', texto: 'Eventos', visivel: pode('automacao.ler') },
    { id: 'regras', texto: 'Regras', visivel: pode('automacao.ler') },
    { id: 'integracoes', texto: 'Integracoes', visivel: pode('automacao.ler') },
    { id: 'parametros', texto: 'Parametros', visivel: pode('automacao.operacao') },
  ];

  const visiveis = abas.filter((a) => a.visivel);
  if (visiveis.length === 0) {
    return <Aviso>Seu perfil nao tem acesso ao centro de operacoes.</Aviso>;
  }

  return (
    <>
      <CabecalhoPagina
        titulo="Centro de operacoes"
        descricao="A automacao esta funcionando? O diagnostico procura tambem o que
          esta FALTANDO — job atrasado, fila parada, detector sem base — porque
          automacao quebra em silencio."
      />

      <nav className="abas">
        {visiveis.map((a) => (
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

      {aba === 'saude' && <Saude />}
      {aba === 'jobs' && <Jobs />}
      {aba === 'fila' && <Fila />}
      {aba === 'eventos' && <Eventos />}
      {aba === 'regras' && <Regras />}
      {aba === 'integracoes' && <Integracoes />}
      {aba === 'parametros' && <Parametros />}
    </>
  );
}

// ---------------------------------------------------------------------------

function Saude() {
  const [painel, setPainel] = useState<any>(null);
  const [diag, setDiag] = useState<any>(null);
  const [serie, setSerie] = useState<any[]>([]);
  const [efeito, setEfeito] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const [p, d, s, e] = await Promise.all([
        api<any>('/automacao/operacao/painel'),
        api<any>('/automacao/operacao/diagnostico'),
        api<any[]>('/automacao/operacao/serie?dias=14'),
        api<any>('/automacao/operacao/efeito?dias=30'),
      ]);
      setPainel(p.data); setDiag(d.data); setSerie(s.data); setEfeito(e.data);
      setErro(null);
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel carregar o painel'));
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  const rodarCiclo = async () => {
    setOcupado(true);
    try {
      await api('/automacao/ciclo', { metodo: 'POST', corpo: {} });
      await carregar();
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel rodar o ciclo'));
    } finally {
      setOcupado(false);
    }
  };

  if (erro) return <Aviso>{erro}</Aviso>;
  if (!painel) return <p className="fraco">Carregando...</p>;

  return (
    <>
      <Cartao
        titulo={`Diagnostico: ${diag?.gravidade ?? '—'}`}
        acoes={(
          <button type="button" className="botao botao--pequeno" disabled={ocupado}
            onClick={rodarCiclo}>
            Processar agora
          </button>
        )}
      >
        {!diag?.sintomas?.length
          ? <Vazio>Nenhum sintoma. Jobs em dia, fila vazia, nada travado.</Vazio>
          : (
            <ul className="lista-sintomas">
              {diag.sintomas.map((s: any, i: number) => (
                <li key={i} className={`sintoma sintoma--${s.gravidade.toLowerCase()}`}>
                  <Etiqueta texto={s.gravidade} tom={TOM_GRAVIDADE[s.gravidade] ?? 'neutro'} />
                  <div>
                    <strong>{s.descricao}</strong>
                    <div className="fraco">→ {s.acao}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        <p className="fraco">Verificado em {dataHora(diag?.verificado_em)}</p>
      </Cartao>

      <div className="grade-indicadores">
        <Indicador rotulo="Eventos 24h" valor={numero(painel.eventos.ultimas_24h)}
          nota={`${numero(painel.eventos.novos)} aguardando processamento`} />
        <Indicador rotulo="Acoes na fila" valor={numero(painel.fila.pendentes)}
          tom={painel.fila.pendentes > 100 ? 'alerta' : 'neutro'}
          nota={painel.fila.fila_morta > 0
            ? `${numero(painel.fila.fila_morta)} na fila morta` : undefined} />
        <Indicador
          rotulo="Sucesso das execucoes"
          valor={painel.execucoes.sucesso_percentual === null
            ? 'sem base' : `${numero(painel.execucoes.sucesso_percentual, 1)}%`}
          tom={painel.execucoes.sucesso_percentual === null ? 'neutro'
            : painel.execucoes.sucesso_percentual >= 99 ? 'acento' : 'alerta'}
          nota={painel.execucoes.sem_base
            ? 'Nenhuma execucao em 24h' : `${numero(painel.execucoes.total_24h)} em 24h`} />
        <Indicador rotulo="Tarefas vencidas" valor={numero(painel.tarefas.vencidas)}
          tom={painel.tarefas.vencidas > 0 ? 'perigo' : 'acento'}
          nota={`${numero(painel.tarefas.abertas)} abertas`} />
        <Indicador rotulo="Aprovacoes pendentes" valor={numero(painel.aprovacoes.pendentes)}
          tom={painel.aprovacoes.vencidas > 0 ? 'perigo' : 'neutro'}
          nota={painel.aprovacoes.vencidas > 0
            ? `${numero(painel.aprovacoes.vencidas)} fora do prazo` : undefined} />
        <Indicador rotulo="Jobs com erro" valor={numero(painel.jobs.com_erro)}
          tom={painel.jobs.com_erro > 0 ? 'perigo' : 'acento'}
          nota={painel.jobs.atrasados > 0
            ? `${numero(painel.jobs.atrasados)} atrasados` : `${numero(painel.jobs.ativos)} ativos`} />
      </div>

      <Cartao titulo="Volume por dia (14 dias)">
        <GraficoLinha
          rotulos={serie.map((d) => String(d.dia).slice(5))}
          series={[
            { nome: 'Eventos', valores: serie.map((d) => d.eventos) },
            { nome: 'Execucoes', valores: serie.map((d) => d.execucoes) },
            { nome: 'Erros', valores: serie.map((d) => d.erros) },
          ]}
        />
      </Cartao>

      <Cartao titulo="Efeito da automacao (30 dias)">
        <p className="fraco">
          A medida util nao e quantas execucoes rodaram, e se o trabalho gerado foi
          resolvido. Descarte alto significa que a automacao esta produzindo tarefa
          que o time julga desnecessaria.
        </p>
        {efeito?.motivo_sem_base
          ? <Vazio>{efeito.motivo_sem_base}</Vazio>
          : (
            <div className="grade-indicadores">
              <Indicador rotulo="Tarefas geradas" valor={numero(efeito?.tarefas?.geradas)} />
              <Indicador rotulo="Concluidas"
                valor={efeito?.tarefas?.conclusao_percentual === null
                  ? '—' : `${numero(efeito?.tarefas?.conclusao_percentual, 1)}%`} />
              <Indicador rotulo="Descartadas"
                valor={efeito?.tarefas?.descarte_percentual === null
                  ? '—' : `${numero(efeito?.tarefas?.descarte_percentual, 1)}%`}
                tom={(efeito?.tarefas?.descarte_percentual ?? 0) > 30 ? 'alerta' : 'neutro'}
                nota="Alto = automacao gerando ruido" />
              <Indicador rotulo="Horas ate concluir"
                valor={efeito?.tarefas?.horas_ate_conclusao === null
                  ? '—' : numero(efeito?.tarefas?.horas_ate_conclusao, 1)} />
              <Indicador rotulo="Alertas gerados" valor={numero(efeito?.alertas?.gerados)}
                nota={`${numero(efeito?.alertas?.ocorrencias)} ocorrencias`} />
              <Indicador rotulo="Aprovacoes solicitadas"
                valor={numero(efeito?.aprovacoes?.solicitadas)}
                nota={`${numero(efeito?.aprovacoes?.excecoes)} excecoes`} />
            </div>
          )}
      </Cartao>
    </>
  );
}

// ---------------------------------------------------------------------------

function Jobs() {
  const { pode } = useAuth();
  const podeExecutar = pode('automacao.executar');
  const [jobs, setJobs] = useState<any[]>([]);
  const [historico, setHistorico] = useState<any[]>([]);
  const [detalhe, setDetalhe] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const [l, h] = await Promise.all([
        api<any[]>('/automacao/jobs'),
        api<any[]>('/automacao/jobs/historico?limite=30'),
      ]);
      setJobs(l.data); setHistorico(h.data); setErro(null);
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel carregar os jobs'));
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  const executar = async (codigo: string) => {
    setOcupado(codigo);
    try {
      await api(`/automacao/jobs/${codigo}/executar`, { metodo: 'POST', corpo: {} });
      await carregar();
    } catch (e) {
      setErro(erroDe(e, `Nao foi possivel executar ${codigo}`));
    } finally {
      setOcupado(null);
    }
  };

  const alternar = async (codigo: string, ativo: boolean) => {
    setOcupado(codigo);
    try {
      await api(`/automacao/jobs/${codigo}/ativo`, { metodo: 'POST', corpo: { ativo } });
      await carregar();
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel alterar o job'));
    } finally {
      setOcupado(null);
    }
  };

  return (
    <>
      {erro && <Aviso>{erro}</Aviso>}

      <Cartao titulo="Jobs agendados">
        <table className="tabela">
          <thead>
            <tr>
              <th>Job</th><th>Frequencia</th><th>Status</th><th>Ultima</th>
              <th>Proxima</th><th>Execucoes</th><th>Falhas</th><th />
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.codigo} className={j.ativo ? '' : 'linha--inativa'}>
                <td>
                  <strong>{j.nome}</strong>
                  <div className="fraco">{j.codigo}</div>
                  {!j.tem_rotina && (
                    <Etiqueta texto="sem rotina implementada" tom="perigo" />
                  )}
                  {j.ultimo_erro && (
                    <div className="fraco" title={j.ultimo_erro}>
                      Ultimo erro: {String(j.ultimo_erro).slice(0, 80)}
                    </div>
                  )}
                </td>
                <td className="fraco">
                  {j.frequencia}
                  {j.intervalo_minutos ? ` (${j.intervalo_minutos} min)` : ''}
                </td>
                <td>
                  <Etiqueta texto={j.status} tom={TOM_STATUS_JOB[j.status] ?? 'neutro'} />
                </td>
                <td className="fraco">{dataHora(j.ultima_execucao)}</td>
                <td className="fraco">{dataHora(j.proxima_execucao)}</td>
                <td>{numero(j.execucoes)}</td>
                <td>
                  {j.falhas > 0
                    ? <Etiqueta texto={`${numero(j.falhas)} (${numero(j.falha_percentual, 1)}%)`}
                        tom="perigo" />
                    : <span className="fraco">0</span>}
                </td>
                <td>
                  {podeExecutar && (
                    <div className="acoes-linha">
                      <button type="button" className="botao botao--fantasma botao--pequeno"
                        disabled={ocupado === j.codigo}
                        onClick={() => executar(j.codigo)}>
                        Executar
                      </button>
                      <button type="button" className="botao botao--fantasma botao--pequeno"
                        disabled={ocupado === j.codigo}
                        onClick={() => alternar(j.codigo, !j.ativo)}>
                        {j.ativo ? 'Desativar' : 'Ativar'}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Cartao>

      <Cartao titulo="Historico de execucao">
        {historico.length === 0
          ? <Vazio>Nenhuma execucao registrada.</Vazio>
          : (
            <table className="tabela">
              <thead>
                <tr>
                  <th>Job</th><th>Status</th><th>Inicio</th><th>Duracao</th>
                  <th>Eventos</th><th>Disparo</th><th /></tr>
              </thead>
              <tbody>
                {historico.map((h) => (
                  <tr key={h.id}>
                    <td>{h.codigo}</td>
                    <td>
                      <Etiqueta texto={h.status}
                        tom={h.status === 'CONCLUIDO' ? 'acento'
                          : h.status === 'ERRO' ? 'perigo' : 'info'} />
                    </td>
                    <td className="fraco">{dataHora(h.iniciado_em)}</td>
                    <td>{h.duracao_ms === null ? '—' : `${numero(h.duracao_ms)} ms`}</td>
                    <td>{numero(h.eventos_gerados)}</td>
                    <td className="fraco">{h.disparado_por}</td>
                    <td>
                      <button type="button" className="botao botao--fantasma botao--pequeno"
                        onClick={() => setDetalhe(h)}>
                        Ver
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Cartao>

      {detalhe && (
        <Modal titulo={`${detalhe.codigo} — ${dataHora(detalhe.iniciado_em)}`}
          largo aoFechar={() => setDetalhe(null)}>
          {detalhe.erro && <Aviso>{detalhe.erro}</Aviso>}
          <pre className="bloco-codigo">{JSON.stringify(detalhe.resultado, null, 2)}</pre>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function Fila() {
  const { pode } = useAuth();
  const podeReprocessar = pode('automacao.reprocessar');
  const [estat, setEstat] = useState<any>(null);
  const [itens, setItens] = useState<any>(null);
  const [filtro, setFiltro] = useState({ status: '', dead_letter: '' });
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filtro.status) params.set('status', filtro.status);
      if (filtro.dead_letter) params.set('dead_letter', filtro.dead_letter);
      params.set('limite', '50');
      const [e, l] = await Promise.all([
        api<any>('/automacao/fila/estatisticas'),
        api<any>(`/automacao/fila?${params}`),
      ]);
      setEstat(e.data); setItens(l.data); setErro(null);
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel carregar a fila'));
    }
  }, [filtro]);

  useEffect(() => { void carregar(); }, [carregar]);

  const reprocessar = async (id: number) => {
    try {
      await api(`/automacao/fila/${id}/reprocessar`, { metodo: 'POST', corpo: {} });
      await carregar();
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel reprocessar'));
    }
  };

  if (erro) return <Aviso>{erro}</Aviso>;

  return (
    <>
      <Cartao titulo="Fila de acoes" acoes={(
        <div className="filtros">
          <Selecao rotulo="Status" valor={filtro.status}
            aoMudar={(v) => setFiltro({ ...filtro, status: v })}
            opcoes={['PENDENTE', 'PROCESSANDO', 'CONCLUIDO', 'ERRO', 'RETRY', 'CANCELADO']
              .map((s) => ({ valor: s, texto: s }))} />
          <Selecao rotulo="Fila morta" valor={filtro.dead_letter}
            aoMudar={(v) => setFiltro({ ...filtro, dead_letter: v })}
            opcoes={[{ valor: 'true', texto: 'Somente fila morta' }]} />
        </div>
      )}>
        <pre className="bloco-codigo">{JSON.stringify(estat, null, 2)}</pre>
      </Cartao>

      <Cartao titulo="Itens">
        {!itens?.itens?.length
          ? <Vazio>Nada na fila com esses filtros.</Vazio>
          : (
            <table className="tabela">
              <thead>
                <tr>
                  <th>Acao</th><th>Status</th><th>Tentativa</th>
                  <th>Criado</th><th>Erro</th><th /></tr>
              </thead>
              <tbody>
                {itens.itens.map((i: any) => (
                  <tr key={i.id}>
                    <td>
                      {i.acao}
                      {i.dead_letter && <> <Etiqueta texto="FILA MORTA" tom="perigo" /></>}
                    </td>
                    <td><Etiqueta texto={i.status}
                      tom={TOM_STATUS_FILA[i.status] ?? 'neutro'} /></td>
                    <td>{numero(i.tentativa)}/{numero(i.max_tentativas)}</td>
                    <td className="fraco">{dataHora(i.created_at)}</td>
                    <td className="fraco" title={i.erro}>
                      {i.erro ? String(i.erro).slice(0, 60) : '—'}
                    </td>
                    <td>
                      {podeReprocessar && (i.dead_letter || i.status === 'ERRO') && (
                        <button type="button" className="botao botao--fantasma botao--pequeno"
                          onClick={() => reprocessar(i.id)}>
                          Reprocessar
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Cartao>
    </>
  );
}

// ---------------------------------------------------------------------------

function Eventos() {
  const [eventos, setEventos] = useState<any>(null);
  const [filtro, setFiltro] = useState({ status: '', tipo: '' });
  const [tipos, setTipos] = useState<any[]>([]);
  const [rastro, setRastro] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    void api<any[]>('/automacao/eventos/tipos')
      .then((r) => setTipos(r.data)).catch(() => undefined);
  }, []);

  const carregar = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filtro.status) params.set('status', filtro.status);
      if (filtro.tipo) params.set('tipo', filtro.tipo);
      params.set('limite', '50');
      const { data } = await api<any>(`/automacao/eventos?${params}`);
      setEventos(data); setErro(null);
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel carregar os eventos'));
    }
  }, [filtro]);

  useEffect(() => { void carregar(); }, [carregar]);

  const rastrear = async (correlationId: string) => {
    try {
      const { data } = await api<any>(`/automacao/rastrear/${correlationId}`);
      setRastro(data);
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel rastrear'));
    }
  };

  if (erro) return <Aviso>{erro}</Aviso>;

  return (
    <>
      <Cartao titulo="Eventos detectados" acoes={(
        <div className="filtros">
          <Selecao rotulo="Status" valor={filtro.status}
            aoMudar={(v) => setFiltro({ ...filtro, status: v })}
            opcoes={['NOVO', 'PROCESSADO', 'ERRO', 'IGNORADO']
              .map((s) => ({ valor: s, texto: s }))} />
          <Selecao rotulo="Tipo" valor={filtro.tipo}
            aoMudar={(v) => setFiltro({ ...filtro, tipo: v })}
            opcoes={tipos.map((t) => ({ valor: t.tipo, texto: t.tipo }))} />
        </div>
      )}>
        {!eventos?.eventos?.length
          ? <Vazio>Nenhum evento com esses filtros.</Vazio>
          : (
            <table className="tabela">
              <thead>
                <tr>
                  <th>Tipo</th><th>Origem</th><th>Entidade</th>
                  <th>Status</th><th>Regras</th><th>Quando</th><th /></tr>
              </thead>
              <tbody>
                {eventos.eventos.map((e: any) => (
                  <tr key={e.id}>
                    <td>{e.tipo}</td>
                    <td className="fraco">{e.origem}</td>
                    <td className="fraco">
                      {e.entidade}{e.entidade_id ? ` ${e.entidade_id}` : ''}
                    </td>
                    <td>
                      <Etiqueta texto={e.status}
                        tom={e.status === 'PROCESSADO' ? 'acento'
                          : e.status === 'ERRO' ? 'perigo' : 'alerta'} />
                    </td>
                    <td>{numero(e.regras_disparadas)}</td>
                    <td className="fraco">{dataHora(e.created_at)}</td>
                    <td>
                      <button type="button" className="botao botao--fantasma botao--pequeno"
                        onClick={() => rastrear(e.correlation_id)}>
                        Rastrear
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Cartao>

      {rastro && (
        <Modal titulo="Linha do tempo da decisao" largo aoFechar={() => setRastro(null)}>
          <p className="fraco">
            O que aconteceu, quando, por qual regra e com que resultado — reconstruido
            a partir do identificador de correlacao.
          </p>
          <dl className="definicoes">
            <dt>Evento</dt>
            <dd>{rastro.evento?.tipo} · {dataHora(rastro.evento?.created_at)}</dd>
            <dt>Execucoes</dt>
            <dd>
              {rastro.execucoes?.length
                ? rastro.execucoes.map((x: any) => (
                  <div key={x.id}>
                    {x.regra ?? '(avulsa)'}
                    {x.regra_versao ? ` v${x.regra_versao}` : ''} → {x.acao}
                    {' · '}<Etiqueta texto={x.status}
                      tom={x.status === 'CONCLUIDO' ? 'acento' : 'perigo'} />
                    {' · '}{numero(x.duracao_ms)} ms
                  </div>
                ))
                : <span className="fraco">nenhuma</span>}
            </dd>
            <dt>Tarefas</dt>
            <dd>
              {rastro.tarefas?.length
                ? rastro.tarefas.map((t: any) => (
                  <div key={t.id}>{t.titulo} · {t.status}
                    {t.nivel_escalonamento > 0 && ` · nivel ${t.nivel_escalonamento}`}</div>
                ))
                : <span className="fraco">nenhuma</span>}
            </dd>
            <dt>Aprovacoes</dt>
            <dd>
              {rastro.aprovacoes?.length
                ? rastro.aprovacoes.map((a: any) => (
                  <div key={a.id}>{a.titulo} · {a.status}</div>
                ))
                : <span className="fraco">nenhuma</span>}
            </dd>
            <dt>Notificacoes</dt>
            <dd>{numero(rastro.notificacoes?.length ?? 0)} enviada(s)</dd>
          </dl>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function Regras() {
  const [regras, setRegras] = useState<any[]>([]);
  const [desempenho, setDesempenho] = useState<any[]>([]);
  const [simulando, setSimulando] = useState<any>(null);
  const [payloadTexto, setPayloadTexto] = useState('{\n  "cobertura_dias": 2\n}');
  const [resultado, setResultado] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [r, d] = await Promise.all([
          api<any[]>('/automacao/regras'),
          api<any[]>('/automacao/operacao/regras-desempenho?dias=30'),
        ]);
        setRegras(r.data); setDesempenho(d.data);
      } catch (e) {
        setErro(erroDe(e, 'Nao foi possivel carregar as regras'));
      }
    })();
  }, []);

  const simular = async () => {
    setResultado(null);
    try {
      const payload = JSON.parse(payloadTexto);
      const { data } = await api<any>(`/automacao/regras/${simulando.id}/simular`, {
        metodo: 'POST', corpo: { payload },
      });
      setResultado(data);
    } catch (e) {
      setResultado({ erro: e instanceof SyntaxError
        ? 'O payload nao e um JSON valido' : erroDe(e, 'Falha ao simular') });
    }
  };

  if (erro) return <Aviso>{erro}</Aviso>;

  const usoPorCodigo = new Map(desempenho.map((d) => [d.codigo, d]));

  return (
    <>
      <Cartao titulo="Regras de automacao">
        <p className="fraco">
          Simular e um ensaio: mostra condicao por condicao se a regra dispararia,
          sem executar a acao.
        </p>
        <table className="tabela">
          <thead>
            <tr>
              <th>Regra</th><th>Evento</th><th>Acao</th><th>Nivel</th>
              <th>Execucoes 30d</th><th /></tr>
          </thead>
          <tbody>
            {regras.map((r) => {
              const uso = usoPorCodigo.get(r.codigo);
              return (
                <tr key={r.id} className={r.ativo ? '' : 'linha--inativa'}>
                  <td>
                    <strong>{r.nome}</strong>
                    <div className="fraco">{r.codigo} · v{r.versao}</div>
                  </td>
                  <td className="fraco">{r.evento}</td>
                  <td>{r.acao}</td>
                  <td>
                    <Etiqueta texto={r.nivel}
                      tom={r.nivel === 'AUTOMATICO' ? 'acento'
                        : r.nivel === 'APROVACAO' ? 'alerta' : 'info'} />
                  </td>
                  <td>
                    {uso
                      ? (
                        <>
                          {numero(uso.execucoes)}
                          {uso.erros > 0 && (
                            <> <Etiqueta texto={`${numero(uso.erro_percentual, 1)}% erro`}
                              tom="perigo" /></>
                          )}
                        </>
                      )
                      : <span className="fraco">nao disparou</span>}
                  </td>
                  <td>
                    <button type="button" className="botao botao--fantasma botao--pequeno"
                      onClick={() => { setSimulando(r); setResultado(null); }}>
                      Simular
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Cartao>

      {simulando && (
        <Modal titulo={`Simular ${simulando.codigo}`} largo
          aoFechar={() => setSimulando(null)}
          rodape={(
            <button type="button" className="botao botao--primario" onClick={simular}>Simular</button>
          )}
        >
          <p className="fraco">
            Payload de exemplo do evento {simulando.evento}. Nada e executado.
          </p>
          <textarea className="entrada-codigo" rows={8} value={payloadTexto}
            onChange={(e) => setPayloadTexto(e.target.value)} />

          {resultado?.erro && <Aviso>{resultado.erro}</Aviso>}
          {resultado && !resultado.erro && (
            <>
              <p>
                <strong>
                  {resultado.dispararia ? 'A regra dispararia' : 'A regra NAO dispararia'}
                </strong>
                {resultado.observacao && <span className="fraco"> — {resultado.observacao}</span>}
              </p>
              <table className="tabela">
                <thead>
                  <tr><th>Campo</th><th>Operador</th><th>Esperado</th>
                    <th>No payload</th><th>Passou</th></tr>
                </thead>
                <tbody>
                  {(resultado.condicoes ?? []).map((c: any, i: number) => (
                    <tr key={i}>
                      <td>{c.campo}</td>
                      <td>{c.operador}</td>
                      <td>{JSON.stringify(c.esperado)}</td>
                      <td>{JSON.stringify(c.valor_no_payload)}</td>
                      <td>
                        <Etiqueta texto={c.passou ? 'sim' : 'nao'}
                          tom={c.passou ? 'acento' : 'perigo'} />
                      </td>
                    </tr>
                  ))}
                  {(resultado.condicoes ?? []).length === 0 && (
                    <tr>
                      <td colSpan={5} className="fraco">
                        Regra sem condicoes: vale para todo evento desse tipo.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </>
          )}
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function Integracoes() {
  const { pode } = useAuth();
  const podeConfigurar = pode('automacao.integracao');
  const [integracoes, setIntegracoes] = useState<any[]>([]);
  const [recebidos, setRecebidos] = useState<any>(null);
  const [definindo, setDefinindo] = useState<any>(null);
  const [segredo, setSegredo] = useState('');
  const [aviso, setAviso] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const [i, w] = await Promise.all([
        api<any[]>('/automacao/integracoes'),
        api<any>('/automacao/webhooks?limite=30'),
      ]);
      setIntegracoes(i.data); setRecebidos(w.data); setErro(null);
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel carregar as integracoes'));
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  const salvarSegredo = async () => {
    try {
      const { message } = await api(
        `/automacao/integracoes/${definindo.codigo}/segredo`,
        { metodo: 'POST', corpo: { segredo } });
      setAviso(message);
      setDefinindo(null);
      setSegredo('');
      await carregar();
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel definir o segredo'));
    }
  };

  return (
    <>
      {erro && <Aviso>{erro}</Aviso>}
      {aviso && <Aviso tipo="ok">{aviso}</Aviso>}

      <Cartao titulo="Integracoes de entrada">
        <p className="fraco">
          O segredo nunca e guardado em texto puro — somente o hash. Por isso ele nao
          pode ser recuperado depois: se o parceiro perder, gera-se um novo.
        </p>
        <table className="tabela">
          <thead>
            <tr>
              <th>Integracao</th><th>Tipo</th><th>Situacao</th>
              <th>Recebidos 7d</th><th>Recusados 7d</th><th>Ultima sincronizacao</th><th /></tr>
          </thead>
          <tbody>
            {integracoes.map((i) => (
              <tr key={i.codigo} className={i.ativo ? '' : 'linha--inativa'}>
                <td>
                  <strong>{i.nome}</strong>
                  <div className="fraco">{i.codigo} · {i.direcao}</div>
                </td>
                <td className="fraco">{i.tipo}</td>
                <td>
                  {i.pronta
                    ? <Etiqueta texto="pronta" tom="acento" />
                    : i.ativo
                      ? <Etiqueta texto="ativa sem segredo" tom="perigo" />
                      : <Etiqueta texto="inativa" tom="neutro" />}
                </td>
                <td>{numero(i.recebidos_7d)}</td>
                <td>
                  {i.rejeitados_7d > 0
                    ? <Etiqueta texto={numero(i.rejeitados_7d)} tom="alerta" />
                    : <span className="fraco">0</span>}
                </td>
                <td className="fraco">{dataHora(i.ultima_sincronizacao)}</td>
                <td>
                  {podeConfigurar && (
                    <button type="button" className="botao botao--fantasma botao--pequeno"
                      onClick={() => setDefinindo(i)}>
                      Definir segredo
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Cartao>

      <Cartao titulo="Webhooks recebidos">
        <p className="fraco">
          Tudo que chega fica registrado, inclusive o recusado — e o que permite
          investigar "o parceiro jura que enviou".
        </p>
        {!recebidos?.webhooks?.length
          ? <Vazio>Nenhum webhook recebido ainda.</Vazio>
          : (
            <table className="tabela">
              <thead>
                <tr>
                  <th>Integracao</th><th>Evento</th><th>Status</th>
                  <th>Motivo</th><th>Quando</th></tr>
              </thead>
              <tbody>
                {recebidos.webhooks.map((w: any) => (
                  <tr key={w.id}>
                    <td>{w.integracao}</td>
                    <td className="fraco">{w.evento ?? '—'}</td>
                    <td><Etiqueta texto={w.status}
                      tom={TOM_WEBHOOK[w.status] ?? 'neutro'} /></td>
                    <td className="fraco">{w.motivo_rejeicao ?? '—'}</td>
                    <td className="fraco">{dataHora(w.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Cartao>

      {definindo && (
        <Modal titulo={`Segredo de ${definindo.nome}`}
          aoFechar={() => setDefinindo(null)}
          rodape={(
            <button type="button" className="botao botao--primario" disabled={segredo.length < 16}
              onClick={salvarSegredo}>
              Salvar
            </button>
          )}
        >
          <p className="fraco">
            Minimo de 16 caracteres. Anote antes de salvar: o sistema guarda apenas o
            hash e nao conseguira mostrar o valor de novo.
          </p>
          <Entrada rotulo="Segredo" valor={segredo} aoMudar={setSegredo}
            placeholder="Combine este valor com o parceiro" />
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function Parametros() {
  const [configs, setConfigs] = useState<any[]>([]);
  const [editando, setEditando] = useState<Record<string, string>>({});
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const { data } = await api<any[]>('/automacao/operacao/configuracoes');
      setConfigs(data);
      setErro(null);
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel carregar os parametros'));
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  const salvar = async (chave: string) => {
    try {
      await api(`/automacao/operacao/configuracoes/${chave}`, {
        metodo: 'PUT', corpo: { valor: editando[chave] },
      });
      setAviso(`${chave} atualizado`);
      setEditando((e) => { const { [chave]: _, ...resto } = e; return resto; });
      await carregar();
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel salvar'));
    }
  };

  return (
    <>
      {erro && <Aviso>{erro}</Aviso>}
      {aviso && <Aviso tipo="ok">{aviso}</Aviso>}

      <Cartao titulo="Parametros da automacao">
        <p className="fraco">
          Os limites moram no banco, nao no codigo: mudar a sensibilidade de um
          detector ou desligar o agendador nao exige nova versao do sistema.
        </p>
        <table className="tabela">
          <thead>
            <tr><th>Parametro</th><th>Valor</th><th>Descricao</th><th /></tr>
          </thead>
          <tbody>
            {configs.map((c) => {
              const emEdicao = editando[c.chave] !== undefined;
              return (
                <tr key={c.chave}>
                  <td className="fraco">{c.chave}</td>
                  <td>
                    {emEdicao
                      ? (
                        <Entrada rotulo="" valor={editando[c.chave]}
                          aoMudar={(v) => setEditando({ ...editando, [c.chave]: v })} />
                      )
                      : <strong>{c.valor}</strong>}
                  </td>
                  <td className="fraco">{c.descricao}</td>
                  <td>
                    {emEdicao
                      ? (
                        <div className="acoes-linha">
                          <button type="button" className="botao botao--fantasma botao--pequeno"
                            onClick={() => setEditando((e) => {
                              const { [c.chave]: _, ...resto } = e; return resto;
                            })}>
                            Cancelar
                          </button>
                          <button type="button" className="botao botao--pequeno"
                            onClick={() => salvar(c.chave)}>
                            Salvar
                          </button>
                        </div>
                      )
                      : (
                        <button type="button" className="botao botao--fantasma botao--pequeno"
                          onClick={() => setEditando({ ...editando, [c.chave]: c.valor })}>
                          Editar
                        </button>
                      )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Cartao>
    </>
  );
}
