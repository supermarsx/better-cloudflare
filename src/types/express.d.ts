declare module 'express' {
  import * as http from 'http';
  export type Request = http.IncomingMessage & {
    headers: Record<string, string | undefined>;
    header: (name: string) => string | undefined; // express request.header
    body?: any;
    params?: any;
    query?: any;
  };
  export type Response = http.ServerResponse & {
    json: (d: any) => Response;
    status: (code: number) => Response;
    send: (d: any) => void;
    sendStatus: (code: number) => void;
    end: () => void;
  };
  export type NextFunction = (err?: any) => void;
  export const Router: any;
  export default {} as any;
}
