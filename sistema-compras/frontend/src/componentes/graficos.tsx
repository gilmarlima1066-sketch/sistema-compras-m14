import type { ReactNode } from 'react';

/* Graficos em SVG puro. Sem biblioteca: os tres formatos usados pelo modulo de
   demanda (serie temporal, barras e barras comparativas) cabem em pouca conta e
   evitam somar 300 KB ao bundle so para desenhar uma linha. */

const PALETA = ['#2f6f4e', '#c9873d', '#4a6fa5', '#8a5a83', '#6b7280'];

export function Legenda({ itens }: { itens: Array<{ cor: string; texto: string }> }) {
  return (
    <div className="grafico__legenda">
      {itens.map((i) => (
        <span key={i.texto}>
          <i style={{ background: i.cor }} /> {i.texto}
        </span>
      ))}
    </div>
  );
}

export function GraficoLinha({ series, rotulos, altura = 190, formatar }: {
  series: Array<{ nome: string; valores: number[]; cor?: string; tracejada?: boolean }>;
  rotulos: string[];
  altura?: number;
  formatar?: (v: number) => string;
}) {
  const largura = 720;
  const margem = { topo: 12, direita: 12, baixo: 26, esquerda: 52 };
  const todos = series.flatMap((s) => s.valores).filter((v) => Number.isFinite(v));
  if (!todos.length) return <div className="vazio">Sem dados para o periodo</div>;

  const maximo = Math.max(...todos, 0);
  const minimo = Math.min(...todos, 0);
  const faixa = maximo - minimo || 1;
  const larguraUtil = largura - margem.esquerda - margem.direita;
  const alturaUtil = altura - margem.topo - margem.baixo;
  const n = Math.max(1, rotulos.length - 1);

  const x = (i: number) => margem.esquerda + (i / n) * larguraUtil;
  const y = (v: number) => margem.topo + alturaUtil - ((v - minimo) / faixa) * alturaUtil;

  const marcas = [0, 0.25, 0.5, 0.75, 1].map((p) => minimo + faixa * p);
  const fmt = formatar ?? ((v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 0 }));
  const passo = Math.max(1, Math.ceil(rotulos.length / 12));

  return (
    <div className="grafico">
      <svg viewBox={`0 0 ${largura} ${altura}`} role="img" preserveAspectRatio="xMidYMid meet">
        {marcas.map((m) => (
          <g key={m}>
            <line x1={margem.esquerda} x2={largura - margem.direita} y1={y(m)} y2={y(m)} className="grafico__grade" />
            <text x={margem.esquerda - 6} y={y(m) + 4} textAnchor="end" className="grafico__rotulo">{fmt(m)}</text>
          </g>
        ))}
        {rotulos.map((r, i) => (i % passo === 0 ? (
          <text key={`${r}-${i}`} x={x(i)} y={altura - 8} textAnchor="middle" className="grafico__rotulo">{r}</text>
        ) : null))}
        {series.map((s, idx) => {
          // Um periodo sem valor apurado nao e zero, e um buraco. A linha e
          // quebrada nele: ligar os dois lados desenharia uma continuidade que
          // o dado nao tem.
          const trechos: Array<Array<{ i: number; v: number }>> = [];
          let atual: Array<{ i: number; v: number }> = [];
          s.valores.forEach((v, i) => {
            if (Number.isFinite(v)) {
              atual.push({ i, v });
            } else if (atual.length) {
              trechos.push(atual);
              atual = [];
            }
          });
          if (atual.length) trechos.push(atual);

          const cor = s.cor ?? PALETA[idx % PALETA.length];
          return (
            <g key={s.nome}>
              {trechos.map((t, n) => (t.length === 1 ? (
                // Ponto isolado entre dois buracos: sem vizinho para ligar.
                <circle key={n} cx={x(t[0]!.i)} cy={y(t[0]!.v)} r={3} fill={cor} />
              ) : (
                <polyline
                  key={n}
                  fill="none"
                  stroke={cor}
                  strokeWidth={2}
                  strokeDasharray={s.tracejada ? '5 4' : undefined}
                  points={t.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')}
                />
              )))}
            </g>
          );
        })}
      </svg>
      {series.length > 1 && (
        <Legenda itens={series.map((s, i) => ({ cor: s.cor ?? PALETA[i % PALETA.length], texto: s.nome }))} />
      )}
    </div>
  );
}

export function GraficoBarras({ dados, altura = 190, formatar, referencia }: {
  dados: Array<{ rotulo: string; valor: number; cor?: string }>;
  altura?: number;
  formatar?: (v: number) => string;
  referencia?: number;
}) {
  const largura = 720;
  const margem = { topo: 12, direita: 12, baixo: 28, esquerda: 52 };
  if (!dados.length) return <div className="vazio">Sem dados para o periodo</div>;

  const maximo = Math.max(...dados.map((d) => d.valor), referencia ?? 0, 0) || 1;
  const larguraUtil = largura - margem.esquerda - margem.direita;
  const alturaUtil = altura - margem.topo - margem.baixo;
  const larguraBarra = (larguraUtil / dados.length) * 0.7;
  const fmt = formatar ?? ((v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 0 }));
  const y = (v: number) => margem.topo + alturaUtil - (v / maximo) * alturaUtil;

  return (
    <div className="grafico">
      <svg viewBox={`0 0 ${largura} ${altura}`} role="img" preserveAspectRatio="xMidYMid meet">
        {[0, 0.5, 1].map((p) => (
          <g key={p}>
            <line x1={margem.esquerda} x2={largura - margem.direita} y1={y(maximo * p)} y2={y(maximo * p)} className="grafico__grade" />
            <text x={margem.esquerda - 6} y={y(maximo * p) + 4} textAnchor="end" className="grafico__rotulo">{fmt(maximo * p)}</text>
          </g>
        ))}
        {referencia !== undefined && (
          <line
            x1={margem.esquerda} x2={largura - margem.direita}
            y1={y(referencia)} y2={y(referencia)}
            stroke="#c9873d" strokeDasharray="5 4" strokeWidth={1.5}
          />
        )}
        {dados.map((d, i) => {
          const cx = margem.esquerda + (i + 0.5) * (larguraUtil / dados.length);
          return (
            <g key={`${d.rotulo}-${i}`}>
              <rect
                x={cx - larguraBarra / 2}
                y={y(Math.max(0, d.valor))}
                width={larguraBarra}
                height={Math.max(1, alturaUtil - (y(Math.max(0, d.valor)) - margem.topo))}
                fill={d.cor ?? PALETA[0]}
                rx={2}
              >
                <title>{`${d.rotulo}: ${fmt(d.valor)}`}</title>
              </rect>
              <text x={cx} y={altura - 9} textAnchor="middle" className="grafico__rotulo">{d.rotulo}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function Matriz({ linhas, colunas, valor, aoClicar, rotulo }: {
  linhas: string[];
  colunas: string[];
  valor: (linha: string, coluna: string) => { numero: number; detalhe?: string } | null;
  aoClicar?: (linha: string, coluna: string) => void;
  rotulo?: ReactNode;
}) {
  const valores = linhas.flatMap((l) => colunas.map((c) => valor(l, c)?.numero ?? 0));
  const maximo = Math.max(...valores, 1);

  return (
    <div className="matriz">
      {rotulo}
      <table>
        <thead>
          <tr>
            <th />
            {colunas.map((c) => <th key={c}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {linhas.map((l) => (
            <tr key={l}>
              <th>{l}</th>
              {colunas.map((c) => {
                const celula = valor(l, c);
                const intensidade = celula ? celula.numero / maximo : 0;
                return (
                  <td
                    key={c}
                    onClick={aoClicar ? () => aoClicar(l, c) : undefined}
                    style={{
                      background: `rgba(47, 111, 78, ${0.08 + intensidade * 0.6})`,
                      cursor: aoClicar ? 'pointer' : undefined,
                    }}
                  >
                    <strong>{celula ? celula.numero.toLocaleString('pt-BR') : '—'}</strong>
                    {celula?.detalhe && <small>{celula.detalhe}</small>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
