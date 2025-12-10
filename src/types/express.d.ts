declare module "express" {
  import * as http from "http";
  export interface Request extends http.IncomingMessage {
    headers: Record<string, string | undefined>;
    header(name: string): string | undefined;
    body?: any;
    params?: any;
    query?: any;
    method?: string;
  }
  export interface Response extends http.ServerResponse {
    json: (d: any) => Response;
    status: (code: number) => Response;
    send: (d: any) => void;
    sendStatus: (code: number) => void;
    end: () => void;
  }
  export type NextFunction = (err?: any) => void;
  export function Router(): any;
  const express: any;
  export default express;
}

