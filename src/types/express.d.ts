declare module 'express' {
  import * as http from 'http';
  export type Request = http.IncomingMessage & { headers: Record<string, string | undefined>; body?: any; params?: any; query?: any; };
  export type Response = http.ServerResponse & { json?: (d: any) => void; status?: (code: number) => any; };
  export type NextFunction = (err?: any) => void;
  export const Router: any;
  export default {} as any;
}
