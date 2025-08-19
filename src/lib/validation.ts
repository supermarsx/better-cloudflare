import { z } from 'zod';
import { RECORD_TYPES } from '../types/dns';

export const dnsRecordSchema = z.object({
  type: z.enum(RECORD_TYPES),
  name: z.string(),
  content: z.string(),
  ttl: z.number().int().optional(),
  priority: z.number().int().optional(),
  proxied: z.boolean().optional(),
});

export type DNSRecordInput = z.infer<typeof dnsRecordSchema>;
