export interface UsuarioAutenticado {
  id: number;
  nome: string;
  email: string;
  perfil_id: number;
  perfil: string;
  permissoes: string[];
}

export interface PayloadToken {
  sub: number;
  perfil: string;
  perfil_id: number;
}
