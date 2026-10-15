import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

/* Pecas do painel de decisao: numeros que contam ate o valor, esqueleto de
   carregamento e graficos em SVG medidos na largura real do cartao (o texto
   nao encolhe com o viewBox). Sem biblioteca, como o resto de graficos.tsx. */

export const COR = {
  atual: '#3f6b2b',
  anterior: '#a7ad9f',
  alta: '#3f6b2b',
  queda: '#c77d2e',
  grade: '#e6e8e1',
} as const;

const semMovimento = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Largura real do elemento, acompanhando o redimensionamento. */
export function useLargura<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [largura, setLargura] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const obs = new ResizeObserver(([e]) => setLargura(Math.floor(e!.contentRect.width)));
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return [ref, largura] as const;
}

/** Conta do valor anterior ate o novo em ~0,8 s; sem animacao se o sistema pedir. */
export function useContagem(alvo: number) {
  const [valor, setValor] = useState(semMovimento() ? alvo : 0);
  const anterior = useRef(0);
  useEffect(() => {
    if (semMovimento()) { setValor(alvo); anterior.current = alvo; return undefined; }
    const de = anterior.current;
    const inicio = performance.now();
    let quadro = 0;
    const passo = (t: number) => {
      const p = Math.min(1, (t - inicio) / 800);
      const suave = 1 - (1 - p) ** 3;
      setValor(de + (alvo - de) * suave);
      if (p < 1) quadro = requestAnimationFrame(passo);
      else anterior.current = alvo;
    };
    quadro = requestAnimationFrame(passo);
    return () => cancelAnimationFrame(quadro);
  }, [alvo]);
  return valor;
}

export function Contagem({ valor, formatar }: { valor: number; formatar: (v: number) => string }) {
  const v = useContagem(valor);
  return <>{formatar(v)}</>;
}

export function Esqueleto({ altura, largura = '100%', className }: {
  altura: number | string; largura?: number | string; className?: string;
}) {
  return <span className={`esqueleto ${className ?? ''}`} style={{ height: altura, width: largura }} aria-hidden />;
}

/** Variacao com seta e texto: a cor nunca e o unico sinal. */
export function Delta({ valor, sufixo = 'vs periodo anterior' }: { valor: number | null; sufixo?: string }) {
  if (valor === null || !Number.isFinite(valor)) {
    return <span className="delta delta--neutro">sem base de comparacao</span>;
  }
  const estavel = Math.abs(valor) < 0.5;
  const classe = estavel ? 'neutro' : valor > 0 ? 'alta' : 'queda';
  const seta = estavel ? '=' : valor > 0 ? '▲' : '▼';
  return (
    <span className={`delta delta--${classe}`}>
      <span aria-hidden>{seta}</span>
      {' '}{estavel ? 'estavel' : `${Math.abs(valor).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`}
      <span className="delta__sufixo"> {sufixo}</span>
    </span>
  );
}

/* ----------------------------------------------------------------- escala */

/** Teto "redondo" e passos limpos para o eixo: 0 / 2 mil / 4 mil... */
function escala(maximo: number, passos = 4) {
  if (maximo <= 0) return { teto: 1, marcas: [0, 1] };
  const bruto = maximo / passos;
  const mag = 10 ** Math.floor(Math.log10(bruto));
  const passo = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((p) => p >= bruto) ?? 10 * mag;
  const teto = Math.ceil(maximo / passo) * passo;
  const marcas: number[] = [];
  for (let v = 0; v <= teto + passo / 2; v += passo) marcas.push(v);
  return { teto, marcas };
}

/** Dica flutuante: valor em destaque, nome em segundo plano. */
function Dica({ x, largura, titulo, linhas }: {
  x: number; largura: number;
  titulo: string; linhas: Array<{ cor: string; nome: string; valor: string; tracejada?: boolean }>;
}) {
  const aDireita = x < largura / 2;
  return (
    <div
      className="dica"
      role="status"
      style={aDireita ? { left: x + 14 } : { right: largura - x + 14 }}
    >
      <div className="dica__titulo">{titulo}</div>
      {linhas.map((l) => (
        <div key={l.nome} className="dica__linha">
          <i style={{ background: l.cor }} />
          <strong>{l.valor}</strong>
          <span>{l.nome}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------- linha: atual x anterior */

export interface PontoSerie { rotulo: string; titulo: string; atual: number; anterior: number | null }

/**
 * Duas linhas no mesmo eixo: o periodo escolhido (verde, com lavagem) e o
 * anterior de mesmo tamanho (cinza), alinhados por posicao. A mira segue o
 * ponteiro e o teclado (setas) e mostra os dois valores.
 */
export function GraficoComparativo({ pontos, formatar, formatarEixo, nomeAtual, nomeAnterior, altura = 260 }: {
  pontos: PontoSerie[];
  formatar: (v: number) => string;
  formatarEixo: (v: number) => string;
  nomeAtual: string;
  nomeAnterior: string;
  altura?: number;
}) {
  const [ref, largura] = useLargura<HTMLDivElement>();
  const [foco, setFoco] = useState<number | null>(null);
  const m = { topo: 14, direita: 18, baixo: 28, esquerda: 58 };
  const n = pontos.length;
  const util = Math.max(10, largura - m.esquerda - m.direita);
  const alto = altura - m.topo - m.baixo;
  const maximo = Math.max(...pontos.map((p) => Math.max(p.atual, p.anterior ?? 0)), 0);
  const { teto, marcas } = escala(maximo);
  const x = (i: number) => m.esquerda + (n <= 1 ? util / 2 : (i / (n - 1)) * util);
  const y = (v: number) => m.topo + alto - (v / teto) * alto;

  const linha = (vals: Array<number | null>) => vals
    .map((v, i) => (v === null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`))
    .filter(Boolean).join(' L');
  const dAtual = `M${linha(pontos.map((p) => p.atual))}`;
  const dArea = `${dAtual} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z`;
  const temAnterior = pontos.some((p) => p.anterior !== null);
  const dAnterior = temAnterior ? `M${linha(pontos.map((p) => p.anterior))}` : '';
  const passoRotulo = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(util / 70))));

  const mover = (clientX: number, alvo: Element) => {
    const r = alvo.getBoundingClientRect();
    const rel = ((clientX - r.left) / r.width) * largura;
    const i = Math.round(((rel - m.esquerda) / util) * (n - 1));
    setFoco(Math.max(0, Math.min(n - 1, i)));
  };
  const teclado = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') setFoco((f) => Math.min(n - 1, (f ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setFoco((f) => Math.max(0, (f ?? n) - 1));
    else if (e.key === 'Escape') setFoco(null);
    else return;
    e.preventDefault();
  };

  const ultimo = pontos[n - 1];
  const p = foco !== null ? pontos[foco] : null;

  return (
    <div className="grafico-vivo" ref={ref}>
      <div className="legenda-serie">
        <span><i style={{ background: COR.atual }} />{nomeAtual}</span>
        {temAnterior && <span><i style={{ background: COR.anterior }} />{nomeAnterior}</span>}
      </div>
      {largura > 0 && n > 0 && (
        <div className="grafico-vivo__area">
          <svg width={largura} height={altura} role="img" aria-label={`${nomeAtual} comparado a ${nomeAnterior}`}>
            {marcas.map((v) => (
              <g key={v}>
                <line x1={m.esquerda} x2={largura - m.direita} y1={y(v)} y2={y(v)} stroke={COR.grade} />
                <text x={m.esquerda - 8} y={y(v) + 4} textAnchor="end" className="eixo">{formatarEixo(v)}</text>
              </g>
            ))}
            {pontos.map((pt, i) => (i % passoRotulo === 0 ? (
              <text key={pt.rotulo + i} x={x(i)} y={altura - 8} textAnchor="middle" className="eixo">{pt.rotulo}</text>
            ) : null))}
            <path d={dArea} fill={COR.atual} opacity={0.1} className="anima-surgir" />
            {temAnterior && (
              <path d={dAnterior} fill="none" stroke={COR.anterior} strokeWidth={2}
                strokeLinejoin="round" strokeLinecap="round" pathLength={1} className="anima-traco" />
            )}
            <path d={dAtual} fill="none" stroke={COR.atual} strokeWidth={2}
              strokeLinejoin="round" strokeLinecap="round" pathLength={1} className="anima-traco" />
            {ultimo && foco === null && (
              <circle cx={x(n - 1)} cy={y(ultimo.atual)} r={4.5} fill={COR.atual} stroke="#fff" strokeWidth={2} className="anima-surgir" />
            )}
            {p && foco !== null && (
              <g>
                <line x1={x(foco)} x2={x(foco)} y1={m.topo} y2={m.topo + alto} stroke="#9aa192" />
                {p.anterior !== null && (
                  <circle cx={x(foco)} cy={y(p.anterior)} r={4.5} fill={COR.anterior} stroke="#fff" strokeWidth={2} />
                )}
                <circle cx={x(foco)} cy={y(p.atual)} r={4.5} fill={COR.atual} stroke="#fff" strokeWidth={2} />
              </g>
            )}
            <rect
              x={m.esquerda} y={m.topo} width={util} height={alto} fill="transparent"
              tabIndex={0}
              className="grafico-vivo__alvo"
              aria-label="Use as setas para percorrer os pontos"
              onPointerMove={(e) => mover(e.clientX, e.currentTarget)}
              onPointerLeave={() => setFoco(null)}
              onKeyDown={teclado}
              onBlur={() => setFoco(null)}
            />
          </svg>
          {p && foco !== null && (
            <Dica
              x={x(foco)} largura={largura} titulo={p.titulo}
              linhas={[
                { cor: COR.atual, nome: nomeAtual, valor: formatar(p.atual) },
                ...(p.anterior !== null ? [{ cor: COR.anterior, nome: nomeAnterior, valor: formatar(p.anterior) }] : []),
              ]}
            />
          )}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- colunas */

const coluna = (x: number, y: number, w: number, h: number) => {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
};

/**
 * Colunas com base unica, ponta arredondada e dica por coluna. A coluna em
 * destaque recebe o acento; as demais ficam no tom secundario.
 */
export function GraficoColunas({ dados, formatar, formatarEixo, altura = 220, referencia, rotuloReferencia }: {
  dados: Array<{ rotulo: string; titulo?: string; valor: number; destaque?: boolean; extra?: string }>;
  formatar: (v: number) => string;
  formatarEixo: (v: number) => string;
  altura?: number;
  referencia?: number;
  rotuloReferencia?: string;
}) {
  const [ref, largura] = useLargura<HTMLDivElement>();
  const [foco, setFoco] = useState<number | null>(null);
  const m = { topo: 18, direita: 12, baixo: 28, esquerda: 52 };
  const util = Math.max(10, largura - m.esquerda - m.direita);
  const alto = altura - m.topo - m.baixo;
  const { teto, marcas } = escala(Math.max(...dados.map((d) => d.valor), referencia ?? 0, 0));
  const banda = util / Math.max(1, dados.length);
  const w = Math.min(24, Math.max(4, banda - 6));
  const y = (v: number) => m.topo + alto - (v / teto) * alto;
  const algumDestaque = dados.some((d) => d.destaque);
  const passoRotulo = Math.max(1, Math.ceil(dados.length / Math.max(2, Math.floor(util / 46))));
  const d = foco !== null ? dados[foco] : null;

  return (
    <div className="grafico-vivo" ref={ref}>
      {largura > 0 && (
        <div className="grafico-vivo__area">
          <svg width={largura} height={altura} role="img">
            {marcas.map((v) => (
              <g key={v}>
                <line x1={m.esquerda} x2={largura - m.direita} y1={y(v)} y2={y(v)} stroke={COR.grade} />
                <text x={m.esquerda - 8} y={y(v) + 4} textAnchor="end" className="eixo">{formatarEixo(v)}</text>
              </g>
            ))}
            {dados.map((item, i) => {
              const cx = m.esquerda + banda * (i + 0.5);
              const h = Math.max(item.valor > 0 ? 2 : 0, alto - (y(item.valor) - m.topo));
              const cor = !algumDestaque || item.destaque ? COR.atual : '#c3c9b9';
              return (
                <g key={`${item.rotulo}-${i}`}>
                  <path
                    d={coluna(cx - w / 2, m.topo + alto - h, w, h)}
                    fill={cor}
                    opacity={foco === null || foco === i ? 1 : 0.55}
                    className="anima-coluna"
                    style={{ animationDelay: `${Math.min(i * 18, 400)}ms` }}
                  />
                  {(i % passoRotulo === 0) && (
                    <text x={cx} y={altura - 8} textAnchor="middle" className="eixo">{item.rotulo}</text>
                  )}
                  <rect
                    x={cx - banda / 2} y={m.topo} width={banda} height={alto} fill="transparent"
                    tabIndex={0}
                    aria-label={`${item.titulo ?? item.rotulo}: ${formatar(item.valor)}`}
                    onPointerEnter={() => setFoco(i)} onPointerLeave={() => setFoco(null)}
                    onFocus={() => setFoco(i)} onBlur={() => setFoco(null)}
                    className="grafico-vivo__alvo"
                  />
                </g>
              );
            })}
            {referencia !== undefined && referencia > 0 && (
              <g pointerEvents="none">
                <line x1={m.esquerda} x2={largura - m.direita} y1={y(referencia)} y2={y(referencia)}
                  stroke="#5b6356" strokeWidth={1} />
                {rotuloReferencia && (
                  <text x={m.esquerda + 4} y={y(referencia) - 6} className="eixo eixo--forte eixo--halo">
                    {rotuloReferencia}
                  </text>
                )}
              </g>
            )}
          </svg>
          {d && foco !== null && (
            <Dica
              x={m.esquerda + banda * (foco + 0.5)} largura={largura} titulo={d.titulo ?? d.rotulo}
              linhas={[
                { cor: !algumDestaque || d.destaque ? COR.atual : '#c3c9b9', nome: '', valor: formatar(d.valor) },
                ...(d.extra ? [{ cor: 'transparent', nome: '', valor: d.extra }] : []),
              ]}
            />
          )}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------- barras horizontais em HTML */

/** Ranking: cada linha e uma barra proporcional ao maior, com valor na ponta. */
export function Ranking({ itens, aoClicar }: {
  itens: Array<{ chave: string | number; rotulo: ReactNode; sub?: ReactNode; valor: number; texto: string; lado?: ReactNode }>;
  aoClicar?: (chave: string | number) => void;
}) {
  const maximo = Math.max(...itens.map((i) => i.valor), 1);
  return (
    <ol className="ranking">
      {itens.map((item, i) => {
        const conteudo = (
          <>
            <span className="ranking__pos">{i + 1}</span>
            <span className="ranking__nome">
              <span className="ranking__rotulo">{item.rotulo}</span>
              {item.sub && <span className="ranking__sub">{item.sub}</span>}
            </span>
            <span className="ranking__barra">
              <span
                className="ranking__preenchido anima-barra"
                style={{ width: `${(item.valor / maximo) * 100}%`, animationDelay: `${i * 40}ms` }}
              />
            </span>
            <span className="ranking__valor">{item.texto}</span>
            <span className="ranking__lado">{item.lado}</span>
          </>
        );
        return (
          <li key={item.chave}>
            {aoClicar
              ? <button type="button" className="ranking__linha" onClick={() => aoClicar(item.chave)}>{conteudo}</button>
              : <div className="ranking__linha">{conteudo}</div>}
          </li>
        );
      })}
    </ol>
  );
}

/** Barras divergentes a partir de um eixo central: ganho a direita, perda a esquerda. */
export function Divergente({ itens, aoClicar }: {
  itens: Array<{ chave: string | number; rotulo: ReactNode; valor: number; texto: string }>;
  aoClicar?: (chave: string | number) => void;
}) {
  const maximo = Math.max(...itens.map((i) => Math.abs(i.valor)), 1);
  return (
    <ul className="divergente">
      {itens.map((item, i) => {
        const pct = (Math.abs(item.valor) / maximo) * 50;
        const alta = item.valor >= 0;
        const conteudo = (
          <>
            <span className="divergente__rotulo">{item.rotulo}</span>
            <span className="divergente__trilho">
              <span className="divergente__eixo" />
              <span
                className={`divergente__barra divergente__barra--${alta ? 'alta' : 'queda'} anima-barra`}
                style={{
                  width: `${pct}%`,
                  [alta ? 'left' : 'right']: '50%',
                  animationDelay: `${i * 40}ms`,
                }}
              />
            </span>
            <span className={`divergente__valor divergente__valor--${alta ? 'alta' : 'queda'}`}>
              {alta ? '▲' : '▼'} {item.texto}
            </span>
          </>
        );
        return (
          <li key={item.chave}>
            {aoClicar
              ? <button type="button" className="divergente__linha" onClick={() => aoClicar(item.chave)}>{conteudo}</button>
              : <div className="divergente__linha">{conteudo}</div>}
          </li>
        );
      })}
    </ul>
  );
}

/** Uma barra 100% em segmentos com 2px de respiro entre eles. */
export function BarraComposicao({ partes }: {
  partes: Array<{ nome: string; valor: number; cor: string; texto: string }>;
}) {
  const total = partes.reduce((s, p) => s + p.valor, 0) || 1;
  return (
    <div className="composicao" role="img"
      aria-label={partes.map((p) => `${p.nome}: ${p.texto}`).join('; ')}>
      {partes.filter((p) => p.valor > 0).map((p, i) => (
        <span
          key={p.nome}
          className="composicao__parte anima-barra"
          title={`${p.nome}: ${p.texto}`}
          style={{ flexGrow: p.valor / total, background: p.cor, animationDelay: `${i * 60}ms` }}
        />
      ))}
    </div>
  );
}
