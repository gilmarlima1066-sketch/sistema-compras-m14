/**
 * Importacao de planilha grande pelo navegador.
 *
 * A Vercel recusa corpo acima de 4,5 MB, entao o arquivo nunca sobe inteiro:
 * e lido aqui (num Web Worker) e enviado em lotes. Tres cuidados de
 * desempenho:
 *
 *   1. So as colunas que o gravador usa vao para o servidor, em matriz (o
 *      nome da coluna vai uma vez por lote, nao uma vez por celula).
 *   2. O tamanho do lote e calculado pelo tamanho real das linhas, para ficar
 *      perto de 3 MB: linha curta, lote maior; menos requisicoes.
 *   3. Lote que falha por rede e reenviado. O servidor reconhece lote ja
 *      gravado e nao grava de novo, entao o reenvio nao duplica itens.
 */
import { api, ErroApi } from '../api/client';
import type { MensagemLeitor } from './leitor.worker';

export interface PlanilhaLida {
  colunas: string[];
  linhas: unknown[][];
  emBranco: number;
}

export function lerPlanilha(
  arquivo: File, aoProgredir?: (etapa: string) => void,
): Promise<PlanilhaLida> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./leitor.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<MensagemLeitor>) => {
      const m = e.data;
      if (m.tipo === 'progresso') { aoProgredir?.(m.etapa); return; }
      worker.terminate();
      if (m.tipo === 'erro') reject(new Error(m.mensagem));
      else resolve({ colunas: m.colunas, linhas: m.linhas, emBranco: m.emBranco });
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'Falha ao ler o arquivo')); };
    worker.postMessage({ arquivo });
  });
}

/** Forma canonica de nome de coluna: "Cod. Produto" e "CODPRODUTO" casam. */
export const canonico = (nome: string) =>
  nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export const linhaParaObjeto = (colunas: string[], linha: unknown[]) =>
  Object.fromEntries(colunas.map((c, i) => [c, linha[i] ?? '']));

const BYTES_ALVO_LOTE = 3_000_000;
const LINHAS_MIN_LOTE = 1_000;
const LINHAS_MAX_LOTE = 25_000;

export interface ProgressoLotes {
  lote: number;
  totalLotes: number;
  linhasEnviadas: number;
  totalLinhas: number;
  /** Linhas por segundo desde o inicio. */
  ritmo: number;
  /** Segundos estimados para terminar. */
  restante: number | null;
}

export interface ResultadoLotes {
  criados: number;
  atualizados: number;
  descartados: number;
  rejeitados: number;
  status?: string;
  motivos?: Record<string, number>;
  pos_processar?: boolean;
  [chave: string]: unknown;
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Falha de rede ou do servidor vale nova tentativa; regra de negocio, nao. */
const vaiDeNovo = (e: unknown) => !(e instanceof ErroApi) || e.status === 0 || e.status >= 500;

export async function gravarEmLotes(opcoes: {
  importacaoId: number;
  planilha: PlanilhaLida;
  /** Colunas que o gravador usa; sem a lista, envia todas. */
  colunasUsadas?: string[];
  aoProgredir: (p: ProgressoLotes) => void;
}): Promise<ResultadoLotes> {
  const { importacaoId, planilha, aoProgredir } = opcoes;

  const desejadas = opcoes.colunasUsadas
    ? new Set(opcoes.colunasUsadas.map(canonico))
    : null;
  const indices = planilha.colunas
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !desejadas || desejadas.has(canonico(c)));
  const nomes = indices.map(({ c }) => c);
  const recortar = (linha: unknown[]) => indices.map(({ i }) => linha[i] ?? '');

  // Tamanho do lote pelo tamanho medio real de uma linha ja recortada.
  const amostra = planilha.linhas.slice(0, 500).map(recortar);
  const bytesPorLinha = Math.max(20, JSON.stringify(amostra).length / Math.max(amostra.length, 1));
  const porLote = Math.min(LINHAS_MAX_LOTE,
    Math.max(LINHAS_MIN_LOTE, Math.floor(BYTES_ALVO_LOTE / bytesPorLinha)));

  const total = planilha.linhas.length;
  const totalLotes = Math.max(1, Math.ceil(total / porLote));
  const inicio = Date.now();
  let ultimo: ResultadoLotes | null = null;

  for (let lote = 0; lote < totalLotes; lote++) {
    const de = lote * porLote;
    const ate = Math.min(de + porLote, total);
    const corpo = {
      lote,
      total_lotes: totalLotes,
      colunas: nomes,
      linhas: planilha.linhas.slice(de, ate).map(recortar),
      linha_inicial: de + 2,
      is_last: lote === totalLotes - 1,
    };

    for (let tentativa = 1; ; tentativa++) {
      try {
        const { data } = await api<ResultadoLotes>(
          `/integracoes/importacoes/${importacaoId}/processar-lote`, { metodo: 'POST', corpo });
        ultimo = data;
        break;
      } catch (e) {
        if (tentativa >= 3 || !vaiDeNovo(e)) {
          const motivo = e instanceof Error ? e.message : 'erro desconhecido';
          throw new Error(`Falha no lote ${lote + 1} de ${totalLotes} (linhas ${de + 2} a ${ate + 1}): ${motivo}`);
        }
        await esperar(2000 * tentativa);
      }
    }

    const segundos = (Date.now() - inicio) / 1000;
    const ritmo = ate / Math.max(segundos, 0.001);
    aoProgredir({
      lote: lote + 1, totalLotes, linhasEnviadas: ate, totalLinhas: total,
      ritmo, restante: ate < total ? (total - ate) / ritmo : 0,
    });
  }

  return ultimo!;
}

/** Atualiza o que depende da importacao (para vendas, as analises de demanda). */
export async function posProcessar(importacaoId: number) {
  return api<{ atualizado: string[]; duracao_ms: number }>(
    `/integracoes/importacoes/${importacaoId}/pos-processar`, { metodo: 'POST', corpo: {} });
}
