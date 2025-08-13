import { z } from 'zod';

export const dnsRecordSchema = z.object({
  type: z.string(),
  name: z.string(),
  content: z.string(),
  ttl: z.number().int().optional(),
  proxied: z.boolean().optional(),
});

export type DNSRecordInput = z.infer<typeof dnsRecordSchema>;
