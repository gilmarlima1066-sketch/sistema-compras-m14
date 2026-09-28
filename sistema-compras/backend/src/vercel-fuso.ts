/*
 * Na Vercel o processo roda em UTC e a variavel TZ e reservada da plataforma.
 * O sistema calcula "hoje" no fuso de quem opera (core/datas.ts) e alinha a
 * sessao do banco a esse mesmo fuso (config/database.ts). Em UTC, entre 21h e
 * meia-noite de Sao Paulo o sistema ja estaria no dia seguinte.
 *
 * O Node aceita trocar o fuso em tempo de execucao. Este modulo e o PRIMEIRO
 * import do ponto de entrada da Vercel, para valer antes de qualquer data.
 */
process.env.TZ = 'America/Sao_Paulo';

export {};
