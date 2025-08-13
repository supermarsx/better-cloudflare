import type { Request, Response } from 'express';
import { CloudflareAPI } from './cloudflare';
import { dnsRecordSchema } from './validation';

const DEBUG = Boolean(process.env.DEBUG_SERVER_API);

function createClient(req: Request): CloudflareAPI {
  const auth = req.header('authorization');
  if (auth?.startsWith('Bearer ')) {
    if (DEBUG) console.debug('Using bearer token for Cloudflare API');
    return new CloudflareAPI(auth.slice(7));
  }
  const key = req.header('x-auth-key');
  const email = req.header('x-auth-email');
  if (key && email) {
    if (DEBUG) console.debug('Using key/email for Cloudflare API');
    return new CloudflareAPI(key, undefined, email);
  }
  const err = new Error('Missing Cloudflare credentials') as Error & {
    status?: number;
  };
  err.status = 400;
  throw err;
}

export class ServerAPI {
  static verifyToken() {
    return async (req: Request, res: Response) => {
      const client = createClient(req);
      await client.verifyToken();
      res.json({ success: true });
    };
  }

  static getZones() {
    return async (req: Request, res: Response) => {
      const client = createClient(req);
      const zones = await client.getZones();
      res.json(zones);
    };
  }

  static getDNSRecords() {
    return async (req: Request, res: Response) => {
      const client = createClient(req);
      const records = await client.getDNSRecords(req.params.zone);
      res.json(records);
    };
  }

  static createDNSRecord() {
    return async (req: Request, res: Response) => {
      const parsed = dnsRecordSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join(', '),
        });
        return;
      }
      const client = createClient(req);
      const record = await client.createDNSRecord(
        req.params.zone,
        parsed.data,
      );
      res.json(record);
    };
  }

  static updateDNSRecord() {
    return async (req: Request, res: Response) => {
      const parsed = dnsRecordSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join(', '),
        });
        return;
      }
      const client = createClient(req);
      const record = await client.updateDNSRecord(
        req.params.zone,
        req.params.id,
        parsed.data,
      );
      res.json(record);
    };
  }

  static deleteDNSRecord() {
    return async (req: Request, res: Response) => {
      const client = createClient(req);
      await client.deleteDNSRecord(req.params.zone, req.params.id);
      res.json({ success: true });
    };
  }
}
