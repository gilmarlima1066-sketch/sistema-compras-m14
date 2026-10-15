import { useState } from 'react';
import { api, ErroApi } from '../api/client';
import type { Fornecedor } from '../api/tipos';
import { useAuth } from '../auth/AuthContext';
import { useLista } from '../hooks/useLista';
import { CabecalhoPagina } from '../componentes/Cabecalho';
import { CONFIG_FORNECEDORES, ImportarPlanilha } from '../componentes/ImportarPlanilha';
import {
  Aviso, Cartao, Entrada, Etiqueta, Modal, Paginacao, Selecao, Vazio, data, moeda, numero,
} from '../componentes/ui';

const TIPOS = ['FABRICANTE', 'DISTRIBUIDOR', 'PRODUTOR', 'IMPORTADOR', 'REPRESENTANTE', 'OUTRO'];

const FORM_VAZIO = {
  razao_social: '', nome_fantasia: '', cnpj: '', email: '', telefone: '',
  cidade: '', estado: '', pais: 'Brasil', tipo_fornecedor: 'DISTRIBUIDOR',
  origem_fornecedor: 'NACIONAL', prazo_medio_pagamento: '', lead_time_padrao_dias: '',
};

/** Formata CNPJ ou CPF apenas para leitura; o backend guarda so digitos. */
const formatarCnpj = (doc: string | null) => {
  if (doc?.length === 14) return doc.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (doc?.length === 11) return doc.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return doc ?? '—';
};

/** Chave liga/desliga: verde e "Ativo" quando ligado; o texto acompanha a cor. */
function ChaveAtivo({ ativo, nome, ocupado, desabilitado, aoTrocar }: {
  ativo: boolean; nome: string; ocupado: boolean; desabilitado: boolean; aoTrocar: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={ativo}
      aria-label={`${nome}: ${ativo ? 'ativo, clique para inativar' : 'inativo, clique para ativar'}`}
      className={`chave${ativo ? ' chave--ligada' : ''}${ocupado ? ' chave--ocupada' : ''}`}
      disabled={desabilitado || ocupado}
      onClick={aoTrocar}
    >
      <span className="chave__trilho" aria-hidden><span className="chave__botao" /></span>
      <span className="chave__texto">{ativo ? 'Ativo' : 'Inativo'}</span>
    </button>
  );
}

export function Fornecedores() {
  const { pode } = useAuth();
  const [busca, setBusca] = useState('');
  const [origem, setOrigem] = useState('');
  const [tipo, setTipo] = useState('');
  const [situacao, setSituacao] = useState('');
  const [pagina, setPagina] = useState(1);

  const { itens, meta, carregando, erro, recarregar } =
    useLista<Fornecedor>('/fornecedores', { pagina, limite: 25, busca, origem, tipo, ativo: situacao });

  // A chave responde na hora; se o servidor recusar, volta e explica.
  const [trocados, setTrocados] = useState<Record<number, boolean>>({});
  const [ocupados, setOcupados] = useState<Set<number>>(new Set());
  const [erroChave, setErroChave] = useState<string | null>(null);
  const podeEditar = pode('fornecedores.editar');

  async function alternar(f: Fornecedor) {
    const novo = !(trocados[f.id] ?? f.ativo);
    setErroChave(null);
    setTrocados((t) => ({ ...t, [f.id]: novo }));
    setOcupados((o) => new Set(o).add(f.id));
    try {
      await api(`/fornecedores/${f.id}/ativo`, { metodo: 'PATCH', corpo: { ativo: novo } });
    } catch (e) {
      setTrocados((t) => ({ ...t, [f.id]: !novo }));
      setErroChave(`Nao foi possivel ${novo ? 'ativar' : 'inativar'} ${f.nome_fantasia ?? f.razao_social}: `
        + (e instanceof ErroApi ? e.message : 'falha de conexao'));
    } finally {
      setOcupados((o) => { const n = new Set(o); n.delete(f.id); return n; });
    }
  }

  const [aberto, setAberto] = useState(false);
  const [form, setForm] = useState({ ...FORM_VAZIO });
  const [erroForm, setErroForm] = useState<string | null>(null);
  const [detalhes, setDetalhes] = useState<Array<{ campo?: string; mensagem: string }>>([]);
  const [salvando, setSalvando] = useState(false);

  const mudar = (campo: keyof typeof FORM_VAZIO) => (valor: string) => setForm((f) => ({ ...f, [campo]: valor }));

  async function salvar() {
    setErroForm(null);
    setDetalhes([]);
    setSalvando(true);
    try {
      await api('/fornecedores', {
        metodo: 'POST',
        corpo: {
          ...form,
          nome_fantasia: form.nome_fantasia || null,
          cnpj: form.cnpj || null,
          email: form.email || null,
          telefone: form.telefone || null,
          cidade: form.cidade || null,
          estado: form.estado || null,
          prazo_medio_pagamento: form.prazo_medio_pagamento ? Number(form.prazo_medio_pagamento) : null,
          lead_time_padrao_dias: form.lead_time_padrao_dias ? Number(form.lead_time_padrao_dias) : null,
        },
      });
      setAberto(false);
      setForm({ ...FORM_VAZIO });
      await recarregar();
    } catch (e) {
      if (e instanceof ErroApi) { setErroForm(e.message); setDetalhes(e.detalhes); }
      else setErroForm('Nao foi possivel salvar o fornecedor');
    } finally {
      setSalvando(false);
    }
  }

  return (
    <>
      <CabecalhoPagina
        titulo="Fornecedores"
        descricao="Base de fornecedores nacionais e internacionais, com prazos e lead time padrao."
        acoes={pode('fornecedores.criar') && (
          <>
            <ImportarPlanilha config={CONFIG_FORNECEDORES} aoConcluir={() => { setTrocados({}); void recarregar(); }} />
            <button type="button" className="botao" onClick={() => setAberto(true)}>
              Novo fornecedor
            </button>
          </>
        )}
      />

      <div className="filtros">
        <Entrada rotulo="Buscar" valor={busca} aoMudar={(v) => { setBusca(v); setPagina(1); }}
          placeholder="nome, CNPJ ou ID do ERP" className="campo--busca" />
        <Selecao rotulo="Situacao" valor={situacao} aoMudar={(v) => { setSituacao(v); setPagina(1); setTrocados({}); }} vazio="Todos"
          opcoes={[{ valor: 'true', texto: 'Ativos' }, { valor: 'false', texto: 'Inativos' }]} />
        <Selecao rotulo="Origem" valor={origem} aoMudar={(v) => { setOrigem(v); setPagina(1); }} vazio="Todas"
          opcoes={[{ valor: 'NACIONAL', texto: 'Nacional' }, { valor: 'INTERNACIONAL', texto: 'Internacional' }]} />
        <Selecao rotulo="Tipo" valor={tipo} aoMudar={(v) => { setTipo(v); setPagina(1); }} vazio="Todos"
          opcoes={TIPOS.map((t) => ({ valor: t, texto: t }))} />
      </div>

      {erro && <Aviso>{erro}</Aviso>}
      {erroChave && <Aviso>{erroChave}</Aviso>}

      <Cartao semCorpo>
        <div className="tabela-wrap">
          <table className="tabela">
            <thead>
              <tr>
                <th>Situacao</th>
                <th>ID ERP</th>
                <th>Fornecedor</th>
                <th>CNPJ / CPF</th>
                <th>Contato</th>
                <th>Local</th>
                <th>Ultimo pedido</th>
                <th className="dir">Lead time (d)</th>
                <th className="dir">Produtos</th>
              </tr>
            </thead>
            <tbody>
              {itens.map((f) => {
                const ativo = trocados[f.id] ?? f.ativo;
                return (
                  <tr key={f.id} className={ativo ? undefined : 'linha-inativa'}>
                    <td>
                      <ChaveAtivo
                        ativo={ativo} nome={f.nome_fantasia ?? f.razao_social}
                        ocupado={ocupados.has(f.id)} desabilitado={!podeEditar}
                        aoTrocar={() => void alternar(f)}
                      />
                    </td>
                    <td className="num">{f.codigo_erp ?? '—'}</td>
                    <td className="celula-produto">
                      <span className="celula-produto__nome">{f.nome_fantasia ?? f.razao_social}</span>
                      {f.nome_fantasia && f.nome_fantasia !== f.razao_social && (
                        <span className="celula-produto__meta">{f.razao_social}</span>
                      )}
                      {f.origem_fornecedor === 'INTERNACIONAL' && <Etiqueta texto="INTERNACIONAL" tom="info" />}
                    </td>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{formatarCnpj(f.cnpj)}</td>
                    <td>
                      <div>{f.contato ?? '—'}</div>
                      {(f.telefone || f.email) && (
                        <div className="celula-produto__meta">{[f.telefone, f.email].filter(Boolean).join(', ')}</div>
                      )}
                    </td>
                    <td>{[f.cidade, f.estado].filter(Boolean).join('/') || f.pais}</td>
                    <td>
                      {f.data_ultimo_pedido ? (
                        <>
                          <div>{data(f.data_ultimo_pedido)}</div>
                          {f.valor_ultimo_pedido ? <div className="celula-produto__meta">{moeda(f.valor_ultimo_pedido)}</div> : null}
                        </>
                      ) : <span className="fraco">nunca</span>}
                    </td>
                    <td className="dir num">{f.lead_time_padrao_dias ?? '—'}</td>
                    <td className="dir num">{numero(f.total_produtos)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {carregando && <div className="carregando">Carregando fornecedores…</div>}
          {!carregando && itens.length === 0 && <Vazio>Nenhum fornecedor encontrado.</Vazio>}
        </div>
        <Paginacao meta={meta} aoTrocar={setPagina} />
      </Cartao>

      {aberto && (
        <Modal
          titulo="Novo fornecedor"
          aoFechar={() => setAberto(false)}
          rodape={(
            <>
              <button type="button" className="botao" onClick={() => setAberto(false)}>Cancelar</button>
              <button type="button" className="botao botao--primario" disabled={salvando} onClick={() => void salvar()}>
                {salvando ? 'Salvando…' : 'Salvar fornecedor'}
              </button>
            </>
          )}
        >
          {erroForm && (
            <Aviso>
              {erroForm}
              {detalhes.length > 0 && (
                <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
                  {detalhes.map((d, i) => <li key={i}>{d.campo}: {d.mensagem}</li>)}
                </ul>
              )}
            </Aviso>
          )}
          <div className="formulario-grade">
            <Entrada rotulo="Razao social" valor={form.razao_social} aoMudar={mudar('razao_social')} className="col-2" />
            <Entrada rotulo="Nome fantasia" valor={form.nome_fantasia} aoMudar={mudar('nome_fantasia')} />
            <Entrada rotulo="CNPJ" valor={form.cnpj} aoMudar={mudar('cnpj')} placeholder="somente digitos" />
            <Selecao rotulo="Tipo" valor={form.tipo_fornecedor} aoMudar={mudar('tipo_fornecedor')} vazio={null}
              opcoes={TIPOS.map((t) => ({ valor: t, texto: t }))} />
            <Selecao rotulo="Origem" valor={form.origem_fornecedor} aoMudar={mudar('origem_fornecedor')} vazio={null}
              opcoes={[{ valor: 'NACIONAL', texto: 'Nacional' }, { valor: 'INTERNACIONAL', texto: 'Internacional' }]} />
            <Entrada rotulo="E-mail" tipo="email" valor={form.email} aoMudar={mudar('email')} />
            <Entrada rotulo="Telefone" valor={form.telefone} aoMudar={mudar('telefone')} />
            <Entrada rotulo="Cidade" valor={form.cidade} aoMudar={mudar('cidade')} />
            <Entrada rotulo="Estado" valor={form.estado} aoMudar={mudar('estado')} />
            <Entrada rotulo="Pais" valor={form.pais} aoMudar={mudar('pais')} />
            <Entrada rotulo="Prazo medio de pagamento (dias)" tipo="number" valor={form.prazo_medio_pagamento} aoMudar={mudar('prazo_medio_pagamento')} />
            <Entrada rotulo="Lead time padrao (dias)" tipo="number" valor={form.lead_time_padrao_dias} aoMudar={mudar('lead_time_padrao_dias')} />
          </div>
          <p style={{ fontSize: 12, color: 'var(--texto-3)', marginTop: 12 }}>
            Fornecedor com origem nacional exige CNPJ — a regra e validada no backend e no banco.
          </p>
        </Modal>
      )}
    </>
  );
}
