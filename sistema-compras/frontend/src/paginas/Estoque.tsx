import { useEffect, useState } from 'react';
import { api, ErroApi } from '../api/client';
import type { OpcaoCadastro, PosicaoEstoque } from '../api/tipos';
import { useAuth } from '../auth/AuthContext';
import { useLista } from '../hooks/useLista';
import { CabecalhoPagina } from '../componentes/Cabecalho';
import {
  Aviso, Cartao, Entrada, Etiqueta, Modal, Paginacao, Selecao, Vazio, data, dataHora, numero,
} from '../componentes/ui';

const SITUACOES = ['RUPTURA', 'ABAIXO_SEGURANCA', 'ABAIXO_MINIMO', 'PONTO_PEDIDO', 'EXCESSO', 'NORMAL'];

const TIPOS_MOVIMENTACAO = [
  'ENTRADA_COMPRA', 'SAIDA_VENDA', 'AJUSTE_POSITIVO', 'AJUSTE_NEGATIVO', 'DEVOLUCAO',
  'TRANSFERENCIA_ENTRADA', 'TRANSFERENCIA_SAIDA', 'PERDA', 'AVARIA', 'INVENTARIO',
];

interface Detalhe {
  consolidado: Record<string, unknown>;
  por_local: Array<Record<string, unknown>>;
  lotes: Array<{ id: number; numero_lote: string; data_validade: string | null; quantidade_atual: number; status: string }>;
  movimentacoes: Array<{ id: number; tipo_movimentacao: string; quantidade: number; created_at: string; local: string; usuario: string | null }>;
}

export function Estoque() {
  const { pode } = useAuth();
  const [busca, setBusca] = useState('');
  const [situacao, setSituacao] = useState('');
  const [pagina, setPagina] = useState(1);

  const { itens, meta, carregando, erro, recarregar } =
    useLista<PosicaoEstoque>('/estoque', { pagina, limite: 25, busca, situacao });

  const [detalhe, setDetalhe] = useState<{ produto: PosicaoEstoque; dados: Detalhe } | null>(null);
  const [movimentando, setMovimentando] = useState<PosicaoEstoque | null>(null);
  const [locais, setLocais] = useState<OpcaoCadastro[]>([]);
  const [mov, setMov] = useState({ local_id: '', tipo_movimentacao: 'ENTRADA_COMPRA', quantidade: '', observacao: '' });
  const [erroMov, setErroMov] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    if (!pode('estoque.movimentar')) return;
    api<OpcaoCadastro[]>('/cadastros/locais').then(({ data: d }) => setLocais(d)).catch(() => undefined);
  }, [pode]);

  async function abrirDetalhe(produto: PosicaoEstoque) {
    try {
      const { data: d } = await api<Detalhe>(`/estoque/${produto.produto_id}`);
      setDetalhe({ produto, dados: d });
    } catch {
      /* erro ja e exibido pela listagem */
    }
  }

  async function registrarMovimentacao() {
    if (!movimentando) return;
    setErroMov(null);
    setSalvando(true);
    try {
      await api('/estoque/movimentacoes', {
        metodo: 'POST',
        corpo: {
          produto_id: movimentando.produto_id,
          local_id: Number(mov.local_id),
          tipo_movimentacao: mov.tipo_movimentacao,
          quantidade: Number(mov.quantidade),
          documento_tipo: 'AJUSTE_MANUAL',
          observacao: mov.observacao || null,
        },
      });
      setMovimentando(null);
      setMov({ local_id: '', tipo_movimentacao: 'ENTRADA_COMPRA', quantidade: '', observacao: '' });
      await recarregar();
    } catch (e) {
      setErroMov(e instanceof ErroApi ? e.message : 'Nao foi possivel registrar a movimentacao');
    } finally {
      setSalvando(false);
    }
  }

  return (
    <>
      <CabecalhoPagina
        titulo="Posicao de estoque"
        descricao="Saldo por SKU com cobertura em dias e situacao frente aos parametros de reposicao."
      />

      <div className="filtros">
        <Entrada rotulo="Buscar" valor={busca} aoMudar={(v) => { setBusca(v); setPagina(1); }}
          placeholder="codigo ou descricao" className="campo--busca" />
        <Selecao rotulo="Situacao" valor={situacao} aoMudar={(v) => { setSituacao(v); setPagina(1); }} vazio="Todas"
          opcoes={SITUACOES.map((s) => ({ valor: s, texto: s.replace(/_/g, ' ') }))} />
      </div>

      {erro && <Aviso>{erro}</Aviso>}

      <Cartao semCorpo>
        <div className="tabela-wrap">
          <table className="tabela">
            <thead>
              <tr>
                <th>Codigo</th>
                <th>Produto</th>
                <th className="dir">Fisico</th>
                <th className="dir">Disponivel</th>
                <th className="dir">Em transito</th>
                <th className="dir">Demanda/dia</th>
                <th className="dir">Cobertura</th>
                <th className="dir">Lead time</th>
                <th>Situacao</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {itens.map((e) => (
                <tr key={e.produto_id}>
                  <td className="codigo">{e.codigo}</td>
                  <td>{e.descricao}</td>
                  <td className="dir num">{numero(e.estoque_fisico, 2)}</td>
                  <td className="dir num">{numero(e.estoque_disponivel, 2)}</td>
                  <td className="dir num">{numero(e.estoque_em_transito, 2)}</td>
                  <td className="dir num">{e.demanda_media_diaria === null ? '—' : numero(e.demanda_media_diaria, 2)}</td>
                  <td className="dir num">{e.cobertura_dias === null ? '—' : `${numero(e.cobertura_dias, 1)} d`}</td>
                  <td className="dir num">{e.lead_time_dias ?? '—'}</td>
                  <td><Etiqueta texto={e.situacao} /></td>
                  <td className="dir" style={{ whiteSpace: 'nowrap' }}>
                    <button type="button" className="botao botao--pequeno" onClick={() => void abrirDetalhe(e)}>Detalhe</button>
                    {pode('estoque.movimentar') && (
                      <button type="button" className="botao botao--pequeno" style={{ marginLeft: 6 }}
                        onClick={() => { setMovimentando(e); setErroMov(null); }}>
                        Movimentar
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {carregando && <div className="carregando">Carregando posicao de estoque…</div>}
          {!carregando && itens.length === 0 && <Vazio>Nenhum item encontrado.</Vazio>}
        </div>
        <Paginacao meta={meta} aoTrocar={setPagina} />
      </Cartao>

      {detalhe && (
        <Modal titulo={`${detalhe.produto.codigo} — ${detalhe.produto.descricao}`} aoFechar={() => setDetalhe(null)}>
          <h4 style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--texto-2)' }}>Lotes em estoque</h4>
          <div className="tabela-wrap" style={{ marginBottom: 18 }}>
            <table className="tabela">
              <thead>
                <tr><th>Lote</th><th>Validade</th><th className="dir">Quantidade</th><th>Status</th></tr>
              </thead>
              <tbody>
                {detalhe.dados.lotes.map((l) => (
                  <tr key={l.id}>
                    <td className="codigo">{l.numero_lote}</td>
                    <td className="num">{data(l.data_validade)}</td>
                    <td className="dir num">{numero(l.quantidade_atual, 2)}</td>
                    <td><Etiqueta texto={l.status} tom={l.status === 'DISPONIVEL' ? 'acento' : 'alerta'} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {detalhe.dados.lotes.length === 0 && <Vazio>Sem lotes com saldo.</Vazio>}
          </div>

          <h4 style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--texto-2)' }}>Ultimas movimentacoes</h4>
          <div className="tabela-wrap">
            <table className="tabela">
              <thead>
                <tr><th>Data</th><th>Tipo</th><th>Local</th><th className="dir">Quantidade</th><th>Usuario</th></tr>
              </thead>
              <tbody>
                {detalhe.dados.movimentacoes.map((m) => (
                  <tr key={m.id}>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{dataHora(m.created_at)}</td>
                    <td>{m.tipo_movimentacao.replace(/_/g, ' ')}</td>
                    <td>{m.local}</td>
                    <td className="dir num">{numero(m.quantidade, 2)}</td>
                    <td>{m.usuario ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {detalhe.dados.movimentacoes.length === 0 && <Vazio>Sem movimentacoes registradas.</Vazio>}
          </div>
        </Modal>
      )}

      {movimentando && (
        <Modal
          titulo={`Movimentar — ${movimentando.codigo}`}
          aoFechar={() => setMovimentando(null)}
          rodape={(
            <>
              <button type="button" className="botao" onClick={() => setMovimentando(null)}>Cancelar</button>
              <button type="button" className="botao botao--primario" disabled={salvando || !mov.local_id || !mov.quantidade}
                onClick={() => void registrarMovimentacao()}>
                {salvando ? 'Registrando…' : 'Registrar'}
              </button>
            </>
          )}
        >
          {erroMov && <Aviso>{erroMov}</Aviso>}
          <div className="formulario-grade">
            <Selecao rotulo="Local" valor={mov.local_id} aoMudar={(v) => setMov((m) => ({ ...m, local_id: v }))}
              vazio="Selecione" opcoes={locais.map((l) => ({ valor: String(l.id), texto: `${l.codigo} — ${l.nome}` }))} />
            <Selecao rotulo="Tipo" valor={mov.tipo_movimentacao} vazio={null}
              aoMudar={(v) => setMov((m) => ({ ...m, tipo_movimentacao: v }))}
              opcoes={TIPOS_MOVIMENTACAO.map((t) => ({ valor: t, texto: t.replace(/_/g, ' ') }))} />
            <Entrada rotulo="Quantidade" tipo="number" valor={mov.quantidade}
              aoMudar={(v) => setMov((m) => ({ ...m, quantidade: v }))} />
            <Entrada rotulo="Observacao" valor={mov.observacao}
              aoMudar={(v) => setMov((m) => ({ ...m, observacao: v }))} />
          </div>
          <p style={{ fontSize: 12, color: 'var(--texto-3)', marginTop: 12 }}>
            Informe sempre a quantidade positiva: o tipo da movimentacao define o sinal.
            Saidas maiores que o saldo sao bloqueadas pelo banco.
          </p>
        </Modal>
      )}
    </>
  );
}
