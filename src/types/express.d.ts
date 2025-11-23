declare module 'express' {
  import * as http from 'http';
  export type Request = http.IncomingMessage & {
    headers: Record<string, string | undefined>;
    header: (name: string) => string | undefined; // express request.header
    body?: unknown;
    params?: Record<string, unknown> | undefined;
    query?: Record<string, unknown> | undefined;
  };
  export type Response = http.ServerResponse & {
    json: (d: unknown) => Response;
    status: (code: number) => Response;
    send: (d: unknown) => void;
    sendStatus: (code: number) => void;
    end: () => void;
  };
  export type NextFunction = (err?: unknown) => void;
  export const Router: unknown;
  export default {} as unknown;
}
