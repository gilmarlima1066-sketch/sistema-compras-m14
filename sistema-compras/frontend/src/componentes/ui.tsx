import type { ChangeEvent, ReactNode } from 'react';
import type { Meta } from '../api/tipos';

/* Primitivas visuais reutilizadas por todas as telas. Nenhuma delas conhece
   regra de negocio — so apresentacao. */

export function Cartao({ titulo, acoes, children, semCorpo }: {
  titulo?: string; acoes?: ReactNode; children: ReactNode; semCorpo?: boolean;
}) {
  return (
    <section className="cartao">
      {titulo && (
        <header className="cartao__cabecalho">
          <h3>{titulo}</h3>
          {acoes && <div style={{ marginLeft: 'auto' }}>{acoes}</div>}
        </header>
      )}
      {semCorpo ? children : <div className="cartao__corpo">{children}</div>}
    </section>
  );
}

type Tom = 'neutro' | 'acento' | 'info' | 'alerta' | 'perigo';

export function Indicador({ rotulo, valor, nota, tom = 'neutro' }: {
  rotulo: string; valor: ReactNode; nota?: string; tom?: Tom;
}) {
  return (
    <div className={`indicador${tom === 'neutro' ? '' : ` indicador--${tom}`}`}>
      <div className="indicador__rotulo">{rotulo}</div>
      <div className="indicador__valor">{valor}</div>
      {nota && <div className="indicador__nota">{nota}</div>}
    </div>
  );
}

const TOM_SITUACAO: Record<string, Tom> = {
  RUPTURA: 'perigo',
  ABAIXO_SEGURANCA: 'perigo',
  ABAIXO_MINIMO: 'alerta',
  PONTO_PEDIDO: 'alerta',
  EXCESSO: 'info',
  NORMAL: 'acento',
  CRITICA: 'perigo',
  ALTA: 'perigo',
  MEDIA: 'alerta',
  BAIXA: 'info',
  INFO: 'neutro',
};

export function Etiqueta({ texto, tom }: { texto: string; tom?: Tom }) {
  const escolhido = tom ?? TOM_SITUACAO[texto] ?? 'neutro';
  const classe = escolhido === 'acento' ? 'ok' : escolhido;
  return <span className={`etiqueta${escolhido === 'neutro' ? '' : ` etiqueta--${classe}`}`}>{texto.replace(/_/g, ' ')}</span>;
}

export function EtiquetaAtivo({ ativo }: { ativo: boolean }) {
  return <Etiqueta texto={ativo ? 'ATIVO' : 'INATIVO'} tom={ativo ? 'acento' : 'neutro'} />;
}

export function Aviso({ tipo = 'erro', children }: { tipo?: 'erro' | 'ok'; children: ReactNode }) {
  return <div className={`aviso aviso--${tipo}`}>{children}</div>;
}

export function Vazio({ children }: { children: ReactNode }) {
  return <div className="vazio">{children}</div>;
}

export function Campo({ rotulo, erro, children }: { rotulo: string; erro?: string; children: ReactNode }) {
  return (
    <label className="campo">
      <span>{rotulo}</span>
      {children}
      {erro && <span className="campo__erro">{erro}</span>}
    </label>
  );
}

export function Entrada(props: {
  rotulo: string;
  valor: string | number;
  aoMudar: (valor: string) => void;
  tipo?: string;
  placeholder?: string;
  erro?: string;
  className?: string;
}) {
  const { rotulo, valor, aoMudar, tipo = 'text', placeholder, erro, className } = props;
  return (
    <div className={`campo ${className ?? ''}`}>
      <label htmlFor={rotulo}>{rotulo}</label>
      <input
        id={rotulo}
        type={tipo}
        value={valor}
        placeholder={placeholder}
        onChange={(e: ChangeEvent<HTMLInputElement>) => aoMudar(e.target.value)}
      />
      {erro && <span className="campo__erro">{erro}</span>}
    </div>
  );
}

export function Selecao({ rotulo, valor, aoMudar, opcoes, erro, className, vazio = '—' }: {
  rotulo: string;
  valor: string;
  aoMudar: (valor: string) => void;
  opcoes: Array<{ valor: string; texto: string }>;
  erro?: string;
  className?: string;
  vazio?: string | null;
}) {
  return (
    <div className={`campo ${className ?? ''}`}>
      <label htmlFor={rotulo}>{rotulo}</label>
      <select id={rotulo} value={valor} onChange={(e) => aoMudar(e.target.value)}>
        {vazio !== null && <option value="">{vazio}</option>}
        {opcoes.map((o) => (
          <option key={o.valor} value={o.valor}>{o.texto}</option>
        ))}
      </select>
      {erro && <span className="campo__erro">{erro}</span>}
    </div>
  );
}

export function Modal({ titulo, aoFechar, rodape, largo, children }: {
  titulo: string; aoFechar: () => void; rodape?: ReactNode; largo?: boolean; children: ReactNode;
}) {
  return (
    <div className="modal-fundo" onMouseDown={(e) => e.target === e.currentTarget && aoFechar()}>
      <div className={`modal${largo ? ' modal--largo' : ''}`} role="dialog" aria-modal="true" aria-label={titulo}>
        <header className="modal__cabecalho">
          <h3>{titulo}</h3>
          <button type="button" className="botao botao--fantasma botao--pequeno" style={{ marginLeft: 'auto' }} onClick={aoFechar}>
            Fechar
          </button>
        </header>
        <div className="modal__corpo">{children}</div>
        {rodape && <footer className="modal__rodape">{rodape}</footer>}
      </div>
    </div>
  );
}

export function Paginacao({ meta, aoTrocar }: { meta?: Meta; aoTrocar: (pagina: number) => void }) {
  if (!meta) return null;
  const { pagina, paginas, total, limite } = meta;
  const de = total === 0 ? 0 : (pagina - 1) * limite + 1;
  const ate = Math.min(pagina * limite, total);
  return (
    <div className="paginacao">
      <span className="num">{de}–{ate}</span> de <span className="num">{total}</span> registros
      <div className="paginacao__controles">
        <button type="button" className="botao botao--pequeno" disabled={pagina <= 1} onClick={() => aoTrocar(pagina - 1)}>
          Anterior
        </button>
        <span className="num">{pagina}/{paginas}</span>
        <button type="button" className="botao botao--pequeno" disabled={pagina >= paginas} onClick={() => aoTrocar(pagina + 1)}>
          Proxima
        </button>
      </div>
    </div>
  );
}

export const numero = (valor: unknown, casas = 0) =>
  Number(valor ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });

export const moeda = (valor: unknown) =>
  Number(valor ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Data de calendario vem da API como "AAAA-MM-DD". `new Date("2026-09-26")` e
 * lido como meia-noite UTC e, num fuso negativo, volta um dia na hora de
 * exibir. Por isso a data-so-dia e formatada pelos proprios numeros, sem
 * passar por fuso nenhum; so um timestamp completo vira Date.
 */
export const data = (valor: string | null | undefined) => {
  if (!valor) return '—';
  const texto = String(valor);
  const soData = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  if (soData) return `${soData[3]}/${soData[2]}/${soData[1]}`;
  const d = new Date(texto);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR');
};

export const dataHora = (valor: string | null) =>
  valor ? new Date(valor).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
