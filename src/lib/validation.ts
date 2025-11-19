import { z } from 'zod';
import { RECORD_TYPES } from '../types/dns';

/**
 * Zod schema describing a DNS record input the application accepts for
 * create/update operations.
 *
 * - `type` should be one of the supported record types
 * - `name` is the record name (host or subdomain)
 * - `content` contains the record contents (IP, domain, etc.)
 * - `ttl` can be a number of seconds or the string 'auto'
 * - `priority` optional (for MX records)
 * - `proxied` optional boolean for Cloudflare proxy
 */
export const dnsRecordSchema = z.object({
  type: z.enum(RECORD_TYPES),
  name: z.string(),
  content: z.string(),
  ttl: z.union([z.literal('auto'), z.number().int()]).optional(),
  priority: z.number().int().optional(),
  proxied: z.boolean().optional(),
});

export type DNSRecordInput = z.infer<typeof dnsRecordSchema>;
