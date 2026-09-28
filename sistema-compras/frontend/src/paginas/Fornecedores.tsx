import { useState } from 'react';
import { api, ErroApi } from '../api/client';
import type { Fornecedor } from '../api/tipos';
import { useAuth } from '../auth/AuthContext';
import { useLista } from '../hooks/useLista';
import { CabecalhoPagina } from '../componentes/Cabecalho';
import {
  Aviso, Cartao, Entrada, Etiqueta, EtiquetaAtivo, Modal, Paginacao, Selecao, Vazio, numero,
} from '../componentes/ui';

const TIPOS = ['FABRICANTE', 'DISTRIBUIDOR', 'PRODUTOR', 'IMPORTADOR', 'REPRESENTANTE', 'OUTRO'];

const FORM_VAZIO = {
  razao_social: '', nome_fantasia: '', cnpj: '', email: '', telefone: '',
  cidade: '', estado: '', pais: 'Brasil', tipo_fornecedor: 'DISTRIBUIDOR',
  origem_fornecedor: 'NACIONAL', prazo_medio_pagamento: '', lead_time_padrao_dias: '',
};

/** Formata o CNPJ apenas para leitura; o backend guarda so digitos. */
const formatarCnpj = (cnpj: string | null) =>
  cnpj && cnpj.length === 14
    ? cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
    : (cnpj ?? '—');

export function Fornecedores() {
  const { pode } = useAuth();
  const [busca, setBusca] = useState('');
  const [origem, setOrigem] = useState('');
  const [tipo, setTipo] = useState('');
  const [pagina, setPagina] = useState(1);

  const { itens, meta, carregando, erro, recarregar } =
    useLista<Fornecedor>('/fornecedores', { pagina, limite: 25, busca, origem, tipo, ativo: 'true' });

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
          <button type="button" className="botao botao--primario" onClick={() => setAberto(true)}>
            Novo fornecedor
          </button>
        )}
      />

      <div className="filtros">
        <Entrada rotulo="Buscar" valor={busca} aoMudar={(v) => { setBusca(v); setPagina(1); }}
          placeholder="razao social, fantasia ou CNPJ" className="campo--busca" />
        <Selecao rotulo="Origem" valor={origem} aoMudar={(v) => { setOrigem(v); setPagina(1); }} vazio="Todas"
          opcoes={[{ valor: 'NACIONAL', texto: 'Nacional' }, { valor: 'INTERNACIONAL', texto: 'Internacional' }]} />
        <Selecao rotulo="Tipo" valor={tipo} aoMudar={(v) => { setTipo(v); setPagina(1); }} vazio="Todos"
          opcoes={TIPOS.map((t) => ({ valor: t, texto: t }))} />
      </div>

      {erro && <Aviso>{erro}</Aviso>}

      <Cartao semCorpo>
        <div className="tabela-wrap">
          <table className="tabela">
            <thead>
              <tr>
                <th>Fornecedor</th>
                <th>CNPJ</th>
                <th>Tipo</th>
                <th>Origem</th>
                <th>Local</th>
                <th className="dir">Prazo (d)</th>
                <th className="dir">Lead time (d)</th>
                <th className="dir">Produtos</th>
                <th>Situacao</th>
              </tr>
            </thead>
            <tbody>
              {itens.map((f) => (
                <tr key={f.id}>
                  <td>
                    <div>{f.nome_fantasia ?? f.razao_social}</div>
                    {f.nome_fantasia && <div style={{ fontSize: 11, color: 'var(--texto-3)' }}>{f.razao_social}</div>}
                  </td>
                  <td className="num">{formatarCnpj(f.cnpj)}</td>
                  <td>{f.tipo_fornecedor}</td>
                  <td>
                    <Etiqueta texto={f.origem_fornecedor} tom={f.origem_fornecedor === 'INTERNACIONAL' ? 'info' : 'neutro'} />
                  </td>
                  <td>{[f.cidade, f.estado].filter(Boolean).join('/') || f.pais}</td>
                  <td className="dir num">{f.prazo_medio_pagamento ?? '—'}</td>
                  <td className="dir num">{f.lead_time_padrao_dias ?? '—'}</td>
                  <td className="dir num">{numero(f.total_produtos)}</td>
                  <td><EtiquetaAtivo ativo={f.ativo} /></td>
                </tr>
              ))}
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
