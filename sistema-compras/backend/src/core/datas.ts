import { z } from 'zod';

/**
 * Data de calendario: um dia, nao um instante.
 *
 * `z.coerce.date()` transforma "2026-09-26" num Date a meia-noite UTC. Quando
 * esse Date vai para uma coluna DATE, o driver o serializa no fuso do processo
 * - e num fuso negativo (America/Sao_Paulo, por exemplo) a data gravada volta
 * um dia: 2026-09-25. Prazo de entrega, data prometida e data necessaria nao
 * podem andar para tras por causa de fuso.
 *
 * Por isso uma data de calendario trafega como texto "YYYY-MM-DD" do request
 * ate o banco, sem nunca virar Date no caminho.
 */
export const dataCalendario = z
  .union([
    z.string().trim().regex(/^\d{4}-\d{2}-\d{2}/, 'Data deve estar no formato AAAA-MM-DD'),
    z.date(),
  ])
  .transform((v) => (typeof v === 'string'
    ? v.slice(0, 10)
    // Um Date so chega aqui quando o cliente mandou um instante completo; nesse
    // caso o dia que vale e o do fuso local de quem opera o sistema.
    : new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10)))
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Data invalida');

export type DataCalendario = z.output<typeof dataCalendario>;

/** Hoje no fuso de quem opera o sistema, nao em UTC. */
export const hojeLocal = (): string => {
  const agora = new Date();
  return new Date(agora.getTime() - agora.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 10);
};

/** Converte o que veio do banco (Date ou texto) para "YYYY-MM-DD". */
export const paraDataCalendario = (valor: unknown): string | null => {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'string') return valor.slice(0, 10);
  const d = valor as Date;
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
