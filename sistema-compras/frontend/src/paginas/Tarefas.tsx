/**
 * Modulo 13 - tarefas e aprovacoes: onde a automacao vira trabalho.
 *
 * Esta e a tela que o comprador abre de manha. Tres decisoes de desenho:
 *
 * 1. "Minhas tarefas" vem primeiro, nao a lista geral. Uma fila de duzentas
 *    tarefas de todo mundo nao ajuda ninguem a comecar o dia; as suas, sim.
 *
 * 2. O SLA aparece como tempo restante, nao como data de vencimento. "Vence em
 *    2h" e uma informacao sobre a qual se age; "vence 28/09 14:00" obriga a
 *    fazer a conta de cabeca - e a conta e refeita a cada tarefa da lista.
 *
 * 3. Toda tarefa mostra a acao sugerida e o caminho para o modulo que resolve.
 *    A tarefa nao executa nada aqui: ela leva a quem tem a alcada.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ErroApi } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { CabecalhoPagina } from '../componentes/Cabecalho';
import {
  Aviso, Cartao, Entrada, Etiqueta, Indicador, Modal, Selecao, Vazio,
  dataHora, moeda, numero,
} from '../componentes/ui';

type Aba = 'minhas' | 'todas' | 'aprovacoes' | 'sla';
type Tom = 'perigo' | 'alerta' | 'info' | 'acento' | 'neutro';

const TOM_PRIORIDADE: Record<string, Tom> = {
  CRITICA: 'perigo', ALTA: 'perigo', MEDIA: 'alerta', BAIXA: 'info',
};

const TOM_SLA: Record<string, Tom> = {
  DENTRO: 'acento', EM_RISCO: 'alerta', VENCIDO: 'perigo', CUMPRIDO: 'acento',
};

const TOM_STATUS: Record<string, Tom> = {
  PENDENTE: 'alerta', EM_ANDAMENTO: 'info',
  CONCLUIDA: 'acento', CANCELADA: 'neutro',
};

const TOM_APROVACAO: Record<string, Tom> = {
  PENDENTE: 'alerta', APROVADA: 'acento', REJEITADA: 'perigo', DISPENSADA: 'neutro',
};

const erroDe = (e: unknown, padrao: string) =>
  (e instanceof ErroApi ? e.message : padrao);

/**
 * Tempo restante em palavras.
 *
 * Devolve o sinal junto com o texto: uma tarefa atrasada nao pode parecer com
 * uma que ainda tem folga so porque as duas mostram um numero.
 */
function prazoEmPalavras(horas: number | null): { texto: string; tom: Tom } {
  if (horas === null || horas === undefined) return { texto: 'sem prazo', tom: 'neutro' };
  if (horas < 0) {
    const atraso = Math.abs(horas);
    return {
      texto: atraso >= 48
        ? `atrasada ha ${Math.round(atraso / 24)} dias`
        : `atrasada ha ${Math.round(atraso)}h`,
      tom: 'perigo',
    };
  }
  if (horas < 1) return { texto: `vence em ${Math.round(horas * 60)} min`, tom: 'perigo' };
  if (horas < 8) return { texto: `vence em ${Math.round(horas)}h`, tom: 'alerta' };
  if (horas < 48) return { texto: `vence em ${Math.round(horas)}h`, tom: 'info' };
  return { texto: `vence em ${Math.round(horas / 24)} dias`, tom: 'acento' };
}

export function Tarefas() {
  const { pode } = useAuth();
  const [aba, setAba] = useState<Aba>('minhas');

  const abas: Array<{ id: Aba; texto: string; visivel: boolean }> = [
    { id: 'minhas', texto: 'Minhas tarefas', visivel: true },
    { id: 'todas', texto: 'Todas as tarefas', visivel: pode('automacao.ler') },
    { id: 'aprovacoes', texto: 'Aprovacoes', visivel: pode('automacao.ler') },
    { id: 'sla', texto: 'Cumprimento de SLA', visivel: pode('automacao.ler') },
  ];

  return (
    <>
      <CabecalhoPagina
        titulo="Tarefas e aprovacoes"
        descricao="O que a automacao detectou e virou trabalho com dono e prazo.
          A tarefa aponta a acao sugerida e leva ao modulo que resolve — decidir
          e executar continua sendo de quem tem a alcada."
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

      {aba === 'minhas' && <MinhasTarefas irParaLista={() => setAba('todas')} />}
      {aba === 'todas' && <TodasTarefas />}
      {aba === 'aprovacoes' && <Aprovacoes />}
      {aba === 'sla' && <DesempenhoSla />}
    </>
  );
}

// ---------------------------------------------------------------------------

function CartaoTarefa({ t, aoAgir }: { t: any; aoAgir: () => void }) {
  const navegar = useNavigate();
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [concluindo, setConcluindo] = useState(false);
  const [observacao, setObservacao] = useState('');

  const prazo = prazoEmPalavras(t.horas_restantes ?? null);

  const agir = async (caminho: string, corpo?: unknown) => {
    setOcupado(true);
    setErro(null);
    try {
      await api(`/automacao/tarefas/${t.id}/${caminho}`, { metodo: 'POST', corpo });
      setConcluindo(false);
      setObservacao('');
      aoAgir();
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel concluir a operacao'));
    } finally {
      setOcupado(false);
    }
  };

  return (
    <article className={`tarefa tarefa--${prazo.tom}`}>
      <header className="tarefa__cabecalho">
        <div>
          <strong>{t.titulo}</strong>
          <div className="tarefa__etiquetas">
            <Etiqueta texto={t.prioridade} tom={TOM_PRIORIDADE[t.prioridade] ?? 'neutro'} />
            <Etiqueta texto={t.status} tom={TOM_STATUS[t.status] ?? 'neutro'} />
            <Etiqueta texto={prazo.texto} tom={prazo.tom} />
            {t.nivel_escalonamento > 0 && (
              <Etiqueta texto={`escalonada nivel ${t.nivel_escalonamento}`} tom="perigo" />
            )}
          </div>
        </div>
      </header>

      {t.descricao && <p className="tarefa__descricao">{t.descricao}</p>}

      {t.acao_sugerida && (
        <p className="tarefa__acao">
          <span className="fraco">Acao sugerida: </span>{t.acao_sugerida}
        </p>
      )}

      <footer className="tarefa__rodape">
        <span className="fraco">
          {t.tipo} · {t.responsavel ? `com ${t.responsavel}` : `perfil ${t.perfil_destino ?? '—'}`}
          {' · '}aberta em {dataHora(t.created_at)}
        </span>

        <div className="tarefa__botoes">
          {t.link && (
            <button type="button" className="botao botao--fantasma botao--pequeno"
              onClick={() => navegar(t.link)}>
              Abrir modulo
            </button>
          )}
          {t.status === 'PENDENTE' && (
            <button type="button" className="botao botao--pequeno" disabled={ocupado}
              onClick={() => agir('assumir')}>
              Assumir
            </button>
          )}
          {(t.status === 'PENDENTE' || t.status === 'EM_ANDAMENTO') && (
            <button type="button" className="botao botao--primario" disabled={ocupado}
              onClick={() => setConcluindo(true)}>
              Concluir
            </button>
          )}
        </div>
      </footer>

      {erro && <Aviso>{erro}</Aviso>}

      {concluindo && (
        <Modal
          titulo="Concluir tarefa"
          aoFechar={() => setConcluindo(false)}
          rodape={(
            <>
              <button type="button" className="botao botao--fantasma botao--pequeno"
                onClick={() => setConcluindo(false)}>Cancelar</button>
              <button type="button" className="botao botao--primario" disabled={ocupado}
                onClick={() => agir('concluir', { observacao: observacao || undefined })}>
                Confirmar conclusao
              </button>
            </>
          )}
        >
          <p className="fraco">
            O que foi feito? O texto fica no historico da tarefa e responde, meses
            depois, por que ela foi encerrada.
          </p>
          <Entrada rotulo="Observacao" valor={observacao} aoMudar={setObservacao}
            placeholder="Ex.: cotacao aberta com tres fornecedores" />
        </Modal>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------

function MinhasTarefas({ irParaLista }: { irParaLista: () => void }) {
  const [dados, setDados] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const { data } = await api<any>('/automacao/tarefas/minhas');
      setDados(data);
      setErro(null);
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel carregar as tarefas'));
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  if (erro) return <Aviso>{erro}</Aviso>;
  if (carregando) return <p className="fraco">Carregando...</p>;

  const minhas = dados?.minhas ?? [];
  const disponiveis = dados?.disponiveis_do_perfil ?? [];
  const minhasTotal = dados?.minhas_total ?? minhas.length;
  const disponiveisTotal = dados?.disponiveis_total ?? disponiveis.length;

  /**
   * Rodape que aparece so quando ha mais do que coube.
   *
   * Sem ele, a pessoa nao teria como saber que existem outras 500 tarefas -
   * e uma tela que esconde volume sem avisar e pior que uma tela cheia.
   */
  const Resto = ({ mostrando, total }: { mostrando: number; total: number }) => (
    total > mostrando
      ? (
        <p className="fraco">
          Mostrando as {mostrando} mais urgentes de {numero(total)}.{' '}
          <button type="button" className="botao botao--fantasma botao--pequeno"
            onClick={irParaLista}>
            Ver a fila completa
          </button>
        </p>
      )
      : null
  );

  return (
    <>
      <div className="grade-indicadores">
        <Indicador rotulo="Atribuidas a voce" valor={numero(minhasTotal)} />
        <Indicador rotulo={`Disponiveis do perfil ${dados?.perfil ?? ''}`}
          valor={numero(disponiveisTotal)}
          nota="Sem dono: qualquer um do perfil pode assumir" />
        <Indicador
          rotulo="Vencidas entre as suas"
          valor={numero(minhas.filter((t: any) => t.sla_status === 'VENCIDO').length)}
          tom={minhas.some((t: any) => t.sla_status === 'VENCIDO') ? 'perigo' : 'neutro'} />
      </div>

      <Cartao titulo="Atribuidas a voce">
        {minhas.length === 0
          ? <Vazio>Nenhuma tarefa atribuida a voce. Se houver trabalho do seu perfil
              sem dono, ele aparece abaixo.</Vazio>
          : (
            <>
              {minhas.map((t: any) => (
                <CartaoTarefa key={t.id} t={t} aoAgir={carregar} />
              ))}
              <Resto mostrando={minhas.length} total={minhasTotal} />
            </>
          )}
      </Cartao>

      <Cartao titulo={`Disponiveis do perfil ${dados?.perfil ?? ''}`}>
        {disponiveis.length === 0
          ? <Vazio>Nada esperando por um dono no seu perfil.</Vazio>
          : (
            <>
              {disponiveis.map((t: any) => (
                <CartaoTarefa key={t.id} t={t} aoAgir={carregar} />
              ))}
              <Resto mostrando={disponiveis.length} total={disponiveisTotal} />
            </>
          )}
      </Cartao>
    </>
  );
}

// ---------------------------------------------------------------------------

function TodasTarefas() {
  const [filtro, setFiltro] = useState({ status: '', prioridade: '', sla_status: '' });
  const [dados, setDados] = useState<any>(null);
  const [resumo, setResumo] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      Object.entries(filtro).forEach(([k, v]) => { if (v) params.set(k, v); });
      params.set('limite', '50');
      const [lista, res] = await Promise.all([
        api<any>(`/automacao/tarefas?${params}`),
        api<any>('/automacao/tarefas/resumo'),
      ]);
      setDados(lista.data);
      setResumo(res.data);
      setErro(null);
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel carregar as tarefas'));
    }
  }, [filtro]);

  useEffect(() => { void carregar(); }, [carregar]);

  if (erro) return <Aviso>{erro}</Aviso>;

  return (
    <>
      <div className="grade-indicadores">
        <Indicador rotulo="Abertas" valor={numero(resumo?.abertas ?? 0)} />
        <Indicador rotulo="Vencidas"
          valor={numero(resumo?.por_sla?.find((s: any) => s.chave === 'VENCIDO')?.total ?? 0)}
          tom="perigo" />
        <Indicador rotulo="Em risco"
          valor={numero(resumo?.por_sla?.find((s: any) => s.chave === 'EM_RISCO')?.total ?? 0)}
          tom="alerta" />
        <Indicador rotulo="Escalonadas"
          valor={numero((resumo?.por_escalonamento ?? [])
            .filter((n: any) => n.nivel > 0)
            .reduce((a: number, n: any) => a + n.total, 0))}
          nota="Passaram do prazo e subiram de nivel" />
      </div>

      <Cartao titulo="Fila completa" acoes={(
        <div className="filtros">
          <Selecao rotulo="Status" valor={filtro.status}
            aoMudar={(v) => setFiltro({ ...filtro, status: v })}
            opcoes={['PENDENTE', 'EM_ANDAMENTO', 'CONCLUIDA', 'CANCELADA']
              .map((s) => ({ valor: s, texto: s }))} />
          <Selecao rotulo="Prioridade" valor={filtro.prioridade}
            aoMudar={(v) => setFiltro({ ...filtro, prioridade: v })}
            opcoes={['CRITICA', 'ALTA', 'MEDIA', 'BAIXA']
              .map((s) => ({ valor: s, texto: s }))} />
          <Selecao rotulo="SLA" valor={filtro.sla_status}
            aoMudar={(v) => setFiltro({ ...filtro, sla_status: v })}
            opcoes={['DENTRO', 'EM_RISCO', 'VENCIDO', 'CUMPRIDO']
              .map((s) => ({ valor: s, texto: s }))} />
        </div>
      )}>
        {!dados?.tarefas?.length
          ? <Vazio>Nenhuma tarefa com esses filtros.</Vazio>
          : (
            <table className="tabela">
              <thead>
                <tr>
                  <th>Tarefa</th><th>Tipo</th><th>Prioridade</th>
                  <th>Responsavel</th><th>SLA</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {dados.tarefas.map((t: any) => {
                  const p = prazoEmPalavras(t.horas_restantes ?? null);
                  return (
                    <tr key={t.id}>
                      <td>
                        {t.titulo}
                        {t.nivel_escalonamento > 0 && (
                          <> <Etiqueta texto={`N${t.nivel_escalonamento}`} tom="perigo" /></>
                        )}
                      </td>
                      <td className="fraco">{t.tipo}</td>
                      <td>
                        <Etiqueta texto={t.prioridade}
                          tom={TOM_PRIORIDADE[t.prioridade] ?? 'neutro'} />
                      </td>
                      <td>{t.responsavel ?? <span className="fraco">
                        {t.perfil_destino ?? '—'}</span>}</td>
                      <td><Etiqueta texto={p.texto} tom={p.tom} /></td>
                      <td><Etiqueta texto={t.status}
                        tom={TOM_STATUS[t.status] ?? 'neutro'} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        {dados?.total > (dados?.tarefas?.length ?? 0) && (
          <p className="fraco">
            Mostrando {dados.tarefas.length} de {numero(dados.total)}.
          </p>
        )}
      </Cartao>
    </>
  );
}

// ---------------------------------------------------------------------------

function Aprovacoes() {
  const { pode } = useAuth();
  const podeAprovar = pode('automacao.aprovar');
  const [fila, setFila] = useState<any[]>([]);
  const [todas, setTodas] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [decidindo, setDecidindo] = useState<any>(null);
  const [justificativa, setJustificativa] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const pedidos: Array<Promise<any>> = [
        api<any>('/automacao/aprovacoes?status=PENDENTE&limite=50'),
      ];
      if (podeAprovar) pedidos.push(api<any>('/automacao/aprovacoes/minha-fila'));
      const [lista, minha] = await Promise.all(pedidos);
      setTodas(lista.data);
      setFila(minha?.data ?? []);
      setErro(null);
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel carregar as aprovacoes'));
    }
  }, [podeAprovar]);

  useEffect(() => { void carregar(); }, [carregar]);

  const decidir = async (caminho: 'aprovar' | 'rejeitar' | 'dispensar') => {
    if (!decidindo) return;
    setOcupado(true);
    try {
      await api(`/automacao/aprovacoes/${decidindo.id}/${caminho}`, {
        metodo: 'POST',
        corpo: { justificativa: justificativa || undefined },
      });
      setDecidindo(null);
      setJustificativa('');
      await carregar();
      setErro(null);
    } catch (e) {
      setErro(erroDe(e, 'Nao foi possivel registrar a decisao'));
    } finally {
      setOcupado(false);
    }
  };

  if (erro) return <Aviso>{erro}</Aviso>;

  return (
    <>
      {podeAprovar && (
        <Cartao titulo="Esperando a sua decisao">
          <p className="fraco">
            Somente o que cabe na sua alcada — e nunca o que voce mesmo solicitou.
          </p>
          {fila.length === 0
            ? <Vazio>Nada esperando por voce.</Vazio>
            : (
              <table className="tabela">
                <thead>
                  <tr>
                    <th>Solicitacao</th><th>Valor</th><th>Alcada</th>
                    <th>Solicitante</th><th>Prazo</th><th /></tr>
                </thead>
                <tbody>
                  {fila.map((a: any) => (
                    <tr key={a.id}>
                      <td>
                        {a.titulo}
                        {a.excecao && <> <Etiqueta texto="EXCECAO" tom="alerta" /></>}
                        {a.motivo_excecao && (
                          <div className="fraco">Motivo: {a.motivo_excecao}</div>
                        )}
                      </td>
                      <td>{a.valor_avaliado ? moeda(a.valor_avaliado) : '—'}</td>
                      <td>{a.alcada ?? <span className="fraco">—</span>}</td>
                      <td className="fraco">{a.solicitante ?? '—'}</td>
                      <td>
                        <Etiqueta texto={a.sla_status}
                          tom={TOM_SLA[a.sla_status] ?? 'neutro'} />
                      </td>
                      <td>
                        <button type="button" className="botao botao--pequeno"
                          onClick={() => setDecidindo(a)}>
                          Decidir
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </Cartao>
      )}

      <Cartao titulo="Todas as solicitacoes pendentes">
        {!todas?.aprovacoes?.length
          ? <Vazio>Nenhuma aprovacao pendente.</Vazio>
          : (
            <table className="tabela">
              <thead>
                <tr>
                  <th>Solicitacao</th><th>Tipo</th><th>Valor</th>
                  <th>Perfil exigido</th><th>Nivel</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {todas.aprovacoes.map((a: any) => (
                  <tr key={a.id}>
                    <td>
                      {a.titulo}
                      {a.excecao && <> <Etiqueta texto="EXCECAO" tom="alerta" /></>}
                    </td>
                    <td className="fraco">{a.tipo}</td>
                    <td>{a.valor_avaliado ? moeda(a.valor_avaliado) : '—'}</td>
                    <td>{a.perfil_exigido ?? <span className="fraco">qualquer</span>}</td>
                    <td>{a.nivel}</td>
                    <td><Etiqueta texto={a.status}
                      tom={TOM_APROVACAO[a.status] ?? 'neutro'} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Cartao>

      {decidindo && (
        <Modal
          titulo={decidindo.titulo}
          aoFechar={() => setDecidindo(null)}
          rodape={(
            <>
              <button type="button" className="botao botao--fantasma botao--pequeno" disabled={ocupado}
                onClick={() => setDecidindo(null)}>Cancelar</button>
              <button type="button" className="botao botao--perigo" disabled={ocupado}
                onClick={() => decidir('rejeitar')}>Rejeitar</button>
              <button type="button" className="botao botao--primario" disabled={ocupado}
                onClick={() => decidir('aprovar')}>Aprovar</button>
            </>
          )}
        >
          <dl className="definicoes">
            <dt>Valor avaliado</dt>
            <dd>{decidindo.valor_avaliado ? moeda(decidindo.valor_avaliado) : '—'}</dd>
            <dt>Alcada</dt><dd>{decidindo.alcada ?? '—'}</dd>
            <dt>Solicitante</dt><dd>{decidindo.solicitante ?? '—'}</dd>
            {decidindo.excecao && (
              <>
                <dt>Motivo da excecao</dt>
                <dd>{decidindo.motivo_excecao}</dd>
              </>
            )}
          </dl>
          <Entrada rotulo="Justificativa" valor={justificativa} aoMudar={setJustificativa}
            placeholder="Obrigatoria para rejeitar; fica no historico da decisao" />
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function DesempenhoSla() {
  const [dados, setDados] = useState<any[]>([]);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { data } = await api<any[]>('/automacao/sla/desempenho?dias=30');
        setDados(data);
      } catch (e) {
        setErro(erroDe(e, 'Nao foi possivel carregar o cumprimento de SLA'));
      }
    })();
  }, []);

  if (erro) return <Aviso>{erro}</Aviso>;

  return (
    <Cartao titulo="Cumprimento de SLA por etapa (30 dias)">
      <p className="fraco">
        O percentual considera apenas tarefas ENCERRADAS. Uma tarefa ainda aberta e
        dentro do prazo nao e descumprimento — conta-la faria o indicador piorar a
        cada tarefa nova.
      </p>
      {dados.length === 0
        ? <Vazio>Nenhuma tarefa no periodo.</Vazio>
        : (
          <table className="tabela">
            <thead>
              <tr>
                <th>Etapa</th><th>Total</th><th>Encerradas com SLA</th>
                <th>No prazo</th><th>Cumprimento</th><th>Vencidas</th>
                <th>Escalonadas</th><th>Horas media</th>
              </tr>
            </thead>
            <tbody>
              {dados.map((l: any) => (
                <tr key={l.etapa}>
                  <td>{l.etapa}</td>
                  <td>{numero(l.total)}</td>
                  <td>{numero(l.encerradas_com_sla)}</td>
                  <td>{numero(l.no_prazo)}</td>
                  <td>
                    {l.cumprimento_percentual === null
                      ? <span className="fraco" title={l.motivo_sem_base}>sem base</span>
                      : (
                        <Etiqueta
                          texto={`${numero(l.cumprimento_percentual, 1)}%`}
                          tom={l.cumprimento_percentual >= 90 ? 'acento'
                            : l.cumprimento_percentual >= 70 ? 'alerta' : 'perigo'} />
                      )}
                  </td>
                  <td>{numero(l.vencidas)}</td>
                  <td>{numero(l.escalonadas)}</td>
                  <td>{l.horas_media === null ? '—' : numero(l.horas_media, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </Cartao>
  );
}
