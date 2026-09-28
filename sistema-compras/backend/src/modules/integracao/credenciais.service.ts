/**
 * Credenciais de integracao (secoes 25, 37 e 42).
 *
 * A regra da secao 25 e uma frase curta com consequencia longa: "nunca
 * armazenar credenciais em texto puro". A forma de cumprir de verdade nao e
 * criptografar o segredo no banco - seria guardar a chave de decifracao ao lado
 * dele, o que apenas muda o nome do problema. A forma e **nao guardar**.
 *
 * O que o banco guarda e uma REFERENCIA: `env:ERP_API_KEY`, `file:/run/secrets/erp`.
 * O segredo vive onde o sistema operacional ou o cofre sabe protege-lo, e este
 * modulo so sabe onde procurar. Quem dump o banco inteiro leva a lista de
 * integracoes e o endereco dos segredos; nao leva um unico token.
 *
 * Consequencia aceita conscientemente: a aplicacao precisa ser reiniciada (ou
 * o cofre recarregado) quando um segredo muda. E o preco de nao ter o segredo
 * no banco, e e barato perto do risco.
 *
 * A secao 42 - nunca usar credencial de producao em desenvolvimento - vira
 * verificacao no momento de USAR, nao so de cadastrar: o ambiente do servidor
 * e comparado com o da credencial, e a divergencia e recusada.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { query, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio, semPermissao } from '../../core/errors.js';
import { texto as configTexto } from './config.js';

export type TipoAutenticacao =
  | 'NENHUMA' | 'API_KEY' | 'BEARER' | 'BASIC' | 'OAUTH2' | 'CERTIFICADO' | 'BANCO';

export type Ambiente = 'DESENVOLVIMENTO' | 'HOMOLOGACAO' | 'PRODUCAO';

export interface Credencial {
  id: number;
  integracao_id: number;
  nome: string;
  tipo: TipoAutenticacao;
  ambiente: Ambiente;
  referencia_segura: string;
  parametros: Record<string, unknown>;
  expira_em: string | null;
}

/** Como a referencia aponta para o segredo. */
const ESQUEMAS = ['env', 'file'] as const;

export const esquemaValido = (referencia: string): boolean =>
  ESQUEMAS.some((e) => referencia.startsWith(`${e}:`));

export const impressaoDigital = (segredo: string): string =>
  createHash('sha256').update(segredo, 'utf8').digest('hex');

/**
 * Resolve a referencia e devolve o segredo.
 *
 * O valor NUNCA e guardado, logado nem devolvido por rota. Ele existe em
 * memoria pelo tempo de montar o cabecalho da requisicao e morre com ela.
 */
async function resolver(referencia: string): Promise<string> {
  const separador = referencia.indexOf(':');
  const esquema = referencia.slice(0, separador);
  const alvo = referencia.slice(separador + 1);

  if (esquema === 'env') {
    const valor = process.env[alvo];
    if (!valor) {
      // A mensagem cita o NOME da variavel, nunca o valor - e o nome e
      // exatamente o que quem for configurar precisa saber.
      throw regraNegocio(
        `A variavel de ambiente ${alvo} nao esta definida neste servidor. `
        + 'Defina-a e reinicie a aplicacao.');
    }
    return valor;
  }

  if (esquema === 'file') {
    try {
      return (await readFile(alvo, 'utf8')).trim();
    } catch {
      throw regraNegocio(`O arquivo de segredo ${alvo} nao pode ser lido neste servidor`);
    }
  }

  throw regraNegocio(
    `Esquema de referencia desconhecido: "${esquema}". Use ${ESQUEMAS.map((e) => `${e}:`).join(' ou ')}`);
}

export async function ambienteDoServidor(): Promise<Ambiente> {
  const bruto = (await configTexto('ambiente', 'DESENVOLVIMENTO')).toUpperCase();
  return (['DESENVOLVIMENTO', 'HOMOLOGACAO', 'PRODUCAO'].includes(bruto)
    ? bruto : 'DESENVOLVIMENTO') as Ambiente;
}

export interface Autenticacao {
  cabecalhos: Record<string, string>;
  query?: Record<string, string>;
  tipo: TipoAutenticacao;
  credencial_id: number | null;
}

/**
 * Monta a autenticacao da requisicao.
 *
 * Devolve cabecalhos prontos, nao o segredo: quem chama nunca precisa ver o
 * valor, e nao pode registra-lo por engano num log de depuracao.
 */
export async function autenticar(integracaoId: number): Promise<Autenticacao> {
  const ambiente = await ambienteDoServidor();

  const { rows } = await query<{
    id: string; tipo: TipoAutenticacao; ambiente: Ambiente;
    referencia_segura: string; parametros: Record<string, unknown>;
    expira_em: string | null;
  }>(`
    SELECT id, tipo, ambiente, referencia_segura, parametros, expira_em
      FROM integracao_credenciais
     WHERE integracao_id = $1 AND ativo
     ORDER BY CASE WHEN ambiente = $2::ambiente_enum THEN 0 ELSE 1 END, id
     LIMIT 1`, [integracaoId, ambiente]);

  const credencial = rows[0];
  if (!credencial) {
    return { cabecalhos: {}, tipo: 'NENHUMA', credencial_id: null };
  }

  /*
   * Secao 42, aplicada onde importa.
   *
   * A checagem e no USO, nao no cadastro: cadastrar a credencial de producao no
   * banco de homologacao pode ser parte de uma migracao legitima. Usa-la a
   * partir de um servidor de desenvolvimento e que nao pode acontecer, e e
   * nesse instante que se recusa.
   */
  if (credencial.ambiente !== ambiente) {
    throw semPermissao(
      `A credencial cadastrada e de ${credencial.ambiente} e este servidor e `
      + `${ambiente}. A secao 42 proibe usar credencial de outro ambiente.`);
  }

  if (credencial.expira_em && new Date(credencial.expira_em) < new Date()) {
    throw regraNegocio(
      `A credencial venceu em ${String(credencial.expira_em).slice(0, 10)}. `
      + 'Rotacione antes de sincronizar.');
  }

  const cabecalhos: Record<string, string> = {};
  const parametrosQuery: Record<string, string> = {};
  const p = credencial.parametros ?? {};

  if (credencial.tipo !== 'NENHUMA') {
    const segredo = await resolver(credencial.referencia_segura);

    switch (credencial.tipo) {
      case 'API_KEY': {
        const nomeHeader = typeof p.header === 'string' ? p.header : 'X-API-Key';
        if (p.em === 'query') {
          parametrosQuery[typeof p.parametro === 'string' ? p.parametro : 'api_key'] = segredo;
        } else {
          cabecalhos[nomeHeader] = segredo;
        }
        break;
      }
      case 'BEARER':
        cabecalhos.Authorization = `Bearer ${segredo}`;
        break;
      case 'BASIC': {
        const usuario = typeof p.usuario === 'string' ? p.usuario : '';
        if (!usuario) {
          throw regraNegocio(
            'Autenticacao Basic exige o usuario em `parametros.usuario`. '
            + 'A senha continua fora do banco, na referencia segura.');
        }
        cabecalhos.Authorization =
          `Basic ${Buffer.from(`${usuario}:${segredo}`, 'utf8').toString('base64')}`;
        break;
      }
      case 'OAUTH2':
        // O fluxo de token exige alcancar o servidor de autorizacao. O que da
        // para fazer sem rede e aceitar um token ja emitido e guardado como
        // referencia - e dizer com todas as letras o que falta.
        cabecalhos.Authorization = `Bearer ${segredo}`;
        break;
      case 'CERTIFICADO':
        throw regraNegocio(
          'Autenticacao por certificado exige o certificado no servidor e '
          + 'configuracao de TLS mutuo; nao e feita pelo cabecalho da requisicao.');
      case 'BANCO':
        // Consumida pelo conector de banco, nao por cabecalho HTTP.
        break;
      default:
        break;
    }
  }

  await query(
    'UPDATE integracao_credenciais SET ultima_utilizacao = now() WHERE id = $1',
    [Number(credencial.id)]);

  return {
    cabecalhos,
    ...(Object.keys(parametrosQuery).length ? { query: parametrosQuery } : {}),
    tipo: credencial.tipo,
    credencial_id: Number(credencial.id),
  };
}

/** String de conexao de banco externo, para o conector BANCO_SQL (secao 23). */
export async function conexaoBanco(integracaoId: number): Promise<{
  url: string; somente_leitura: boolean;
}> {
  const ambiente = await ambienteDoServidor();
  const { rows } = await query<{
    referencia_segura: string; ambiente: Ambiente; parametros: Record<string, unknown>;
  }>(`
    SELECT referencia_segura, ambiente, parametros
      FROM integracao_credenciais
     WHERE integracao_id = $1 AND ativo AND tipo = 'BANCO'
     ORDER BY CASE WHEN ambiente = $2::ambiente_enum THEN 0 ELSE 1 END, id
     LIMIT 1`, [integracaoId, ambiente]);

  const credencial = rows[0];
  if (!credencial) {
    throw regraNegocio('Nenhuma credencial de banco cadastrada para esta integracao');
  }
  if (credencial.ambiente !== ambiente) {
    throw semPermissao(
      `Credencial de ${credencial.ambiente} em servidor ${ambiente} (secao 42)`);
  }

  const url = await resolver(credencial.referencia_segura);
  // A secao 23 manda priorizar usuario somente leitura para analitico. O
  // sinalizador vem da configuracao da credencial e o conector o respeita.
  return { url, somente_leitura: credencial.parametros?.somente_leitura !== false };
}

// ---------------------------------------------------------------------------
// Cadastro
// ---------------------------------------------------------------------------

export interface EntradaCredencial {
  integracao_id: number;
  nome: string;
  tipo: TipoAutenticacao;
  ambiente?: Ambiente;
  referencia_segura: string;
  parametros?: Record<string, unknown>;
  expira_em?: string | null;
}

/**
 * Cadastra a referencia. Recusa qualquer coisa que PARECA um segredo.
 *
 * A trava nao e perfeita nem pretende ser - e a rede que pega o caso comum:
 * alguem cola o token no campo errado porque o formulario parecia pedir isso.
 * Uma recusa clara aqui vale mais que uma politica no manual.
 */
export async function cadastrar(
  entrada: EntradaCredencial, contexto: ContextoSessao,
): Promise<{ id: number; referencia: string; aviso?: string }> {
  const referencia = entrada.referencia_segura.trim();

  if (!esquemaValido(referencia)) {
    throw regraNegocio(
      `A referencia precisa apontar para onde o segredo esta, nao conter o segredo. `
      + `Use ${ESQUEMAS.map((e) => `${e}:NOME`).join(' ou ')} — `
      + 'por exemplo env:ERP_API_KEY.');
  }

  const alvo = referencia.slice(referencia.indexOf(':') + 1);
  if (/[\s]/.test(alvo) || alvo.length > 160) {
    throw regraNegocio('O alvo da referencia nao parece um nome de variavel ou caminho');
  }
  // Um alvo longo, sem separador e com mistura de maiusculas, minusculas e
  // digitos tem cara de token colado por engano.
  if (alvo.length > 40 && /[a-z]/.test(alvo) && /[A-Z]/.test(alvo) && /\d/.test(alvo)
      && !alvo.includes('/') && !alvo.includes('_')) {
    throw regraNegocio(
      'O valor informado parece ser o proprio segredo, nao uma referencia. '
      + 'Guarde o segredo em variavel de ambiente e aponte para ela.');
  }

  const ambiente = entrada.ambiente ?? await ambienteDoServidor();

  const { rows } = await query<{ id: string }>(`
    INSERT INTO integracao_credenciais
      (integracao_id, nome, tipo, ambiente, referencia_segura, parametros,
       expira_em, created_by)
    VALUES ($1, $2, $3::tipo_autenticacao_enum, $4::ambiente_enum, $5, $6::jsonb,
            $7::timestamptz, $8)
    RETURNING id`,
  [entrada.integracao_id, entrada.nome, entrada.tipo, ambiente, referencia,
    JSON.stringify(higienizarParametros(entrada.parametros ?? {})),
    entrada.expira_em ?? null, contexto.usuarioId ?? null]);

  // Confere se a referencia resolve AGORA, para o erro aparecer no cadastro e
  // nao as tres da manha, quando o job tentar sincronizar.
  let aviso: string | undefined;
  if (entrada.tipo !== 'NENHUMA') {
    try {
      const segredo = await resolver(referencia);
      await query(
        'UPDATE integracao_credenciais SET impressao_digital = $2 WHERE id = $1',
        [Number(rows[0]!.id), impressaoDigital(segredo)]);
    } catch (erro) {
      aviso = erro instanceof Error ? erro.message : String(erro);
    }
  }

  return {
    id: Number(rows[0]!.id),
    referencia,
    ...(aviso ? { aviso } : {}),
  };
}

/**
 * Remove de `parametros` qualquer campo que cheire a segredo.
 *
 * `parametros` guarda o que NAO e sigiloso: usuario do Basic, nome do header.
 * A secao 37 proibe token em log, e esta coluna aparece em tela e em log.
 */
function higienizarParametros(p: Record<string, unknown>): Record<string, unknown> {
  const proibidos = ['senha', 'password', 'secret', 'token', 'chave', 'key',
    'api_key', 'apikey', 'client_secret', 'private_key', 'passphrase'];
  const limpo: Record<string, unknown> = {};
  for (const [chave, valor] of Object.entries(p)) {
    if (proibidos.includes(chave.toLowerCase())) continue;
    limpo[chave] = valor;
  }
  return limpo;
}

/** Rotacao: a nova referencia passa a valer e a antiga e desativada (secao 37). */
export async function rotacionar(
  id: number, novaReferencia: string, contexto: ContextoSessao,
): Promise<{ id: number; mudou: boolean; aviso?: string }> {
  const { rows } = await query<{
    integracao_id: string; nome: string; tipo: TipoAutenticacao; ambiente: Ambiente;
    parametros: Record<string, unknown>; impressao_digital: string | null;
  }>(`SELECT integracao_id, nome, tipo, ambiente, parametros, impressao_digital
        FROM integracao_credenciais WHERE id = $1 AND ativo`, [id]);

  const atual = rows[0];
  if (!atual) throw naoEncontrado('Credencial ativa');

  await query('UPDATE integracao_credenciais SET ativo = false WHERE id = $1', [id]);

  const nova = await cadastrar({
    integracao_id: Number(atual.integracao_id),
    nome: atual.nome,
    tipo: atual.tipo,
    ambiente: atual.ambiente,
    referencia_segura: novaReferencia,
    parametros: atual.parametros,
  }, contexto);

  await query(
    'UPDATE integracao_credenciais SET rotacionada_em = now() WHERE id = $1', [nova.id]);

  // A impressao digital responde "o segredo mudou mesmo?" sem ninguem precisar
  // ver nenhum dos dois valores.
  const { rows: depois } = await query<{ impressao_digital: string | null }>(
    'SELECT impressao_digital FROM integracao_credenciais WHERE id = $1', [nova.id]);

  const mudou = !atual.impressao_digital || !depois[0]?.impressao_digital
    || atual.impressao_digital !== depois[0].impressao_digital;

  return {
    id: nova.id,
    mudou,
    ...(nova.aviso ? { aviso: nova.aviso }
      : !mudou ? { aviso: 'A nova referencia aponta para o MESMO segredo de antes' }
        : {}),
  };
}

export async function listar(integracaoId?: number) {
  const { rows } = await query(`
    SELECT c.id, c.integracao_id, i.codigo AS integracao, c.nome,
           c.tipo::text AS tipo, c.ambiente::text AS ambiente,
           c.referencia_segura, c.parametros, c.expira_em, c.rotacionada_em,
           c.ultima_utilizacao, c.ativo, c.created_at,
           -- A impressao digital sai truncada: serve para comparar duas
           -- credenciais, nao para levar ao segredo.
           left(c.impressao_digital, 12) AS impressao,
           CASE WHEN c.expira_em IS NULL THEN NULL
                ELSE (c.expira_em::date - CURRENT_DATE) END AS dias_para_vencer
      FROM integracao_credenciais c
      JOIN integracoes i ON i.id = c.integracao_id
     ${integracaoId ? 'WHERE c.integracao_id = $1' : ''}
     ORDER BY i.codigo, c.ativo DESC, c.id DESC`,
  integracaoId ? [integracaoId] : []);

  return rows.map((r) => {
    const c = r as Record<string, unknown>;
    return {
      ...c,
      dias_para_vencer: c.dias_para_vencer === null ? null : Number(c.dias_para_vencer),
    };
  });
}

export async function desativar(id: number): Promise<void> {
  const { rowCount } = await query(
    'UPDATE integracao_credenciais SET ativo = false WHERE id = $1 AND ativo', [id]);
  if (!rowCount) throw naoEncontrado('Credencial ativa');
}

/**
 * Credenciais vencendo, para o job de saude (secao 37: rotacao).
 *
 * Uma credencial que vence sem aviso derruba a integracao numa madrugada e o
 * diagnostico vira "erro de autenticacao" sem causa aparente.
 */
export interface CredencialVencendo {
  id: number; nome: string; integracao: string; integracao_id: number;
  ambiente: string; expira_em: string; dias: number;
}

export async function vencendo(dias: number): Promise<CredencialVencendo[]> {
  const { rows } = await query<Record<string, unknown>>(`
    SELECT c.id, c.nome, i.codigo AS integracao, i.id AS integracao_id,
           c.ambiente::text AS ambiente, c.expira_em,
           (c.expira_em::date - CURRENT_DATE) AS dias
      FROM integracao_credenciais c
      JOIN integracoes i ON i.id = c.integracao_id
     WHERE c.ativo AND c.expira_em IS NOT NULL
       AND c.expira_em::date <= CURRENT_DATE + $1::int
     ORDER BY c.expira_em`, [dias]);
  return rows.map((r) => ({
    id: Number(r.id),
    nome: String(r.nome),
    integracao: String(r.integracao),
    integracao_id: Number(r.integracao_id),
    ambiente: String(r.ambiente),
    expira_em: String(r.expira_em),
    dias: Number(r.dias),
  }));
}

/** Diagnostico: a referencia resolve neste servidor? Sem revelar o valor. */
export async function verificar(id: number): Promise<{
  id: number; resolve: boolean; ambiente_confere: boolean; motivo?: string;
}> {
  const { rows } = await query<{
    referencia_segura: string; ambiente: Ambiente; tipo: TipoAutenticacao;
  }>('SELECT referencia_segura, ambiente, tipo FROM integracao_credenciais WHERE id = $1',
  [id]);

  const credencial = rows[0];
  if (!credencial) throw naoEncontrado('Credencial');

  const ambiente = await ambienteDoServidor();
  const confere = credencial.ambiente === ambiente;

  if (credencial.tipo === 'NENHUMA') {
    return { id, resolve: true, ambiente_confere: confere };
  }

  try {
    await resolver(credencial.referencia_segura);
    return {
      id, resolve: true, ambiente_confere: confere,
      ...(confere ? {} : {
        motivo: `Credencial de ${credencial.ambiente} em servidor ${ambiente}: `
          + 'sera recusada no uso (secao 42)',
      }),
    };
  } catch (erro) {
    return {
      id, resolve: false, ambiente_confere: confere,
      motivo: erro instanceof Error ? erro.message : String(erro),
    };
  }
}
