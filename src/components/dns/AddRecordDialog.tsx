/**
 * Dialog used to collect DNS record properties required to create a new
 * record via the API.
 */
import type { ChangeEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import type { DNSRecord, RecordType } from '@/types/dns';
import { RECORD_TYPES, TTL_PRESETS } from '@/types/dns';
import { Plus } from 'lucide-react';

/**
 * Props for the AddRecordDialog component which collects fields to create a
 * new DNS record (type, name, content, ttl, etc.).
 */
export interface AddRecordDialogProps {
  /** Whether the dialog is currently open */
  open: boolean;
  /** Callback invoked when open state changes (open/close) */
  onOpenChange: (open: boolean) => void;
  /** Working DNS record object for the form */
  record: Partial<DNSRecord>;
  /** Called when fields in the form change with the updated record */
  onRecordChange: (record: Partial<DNSRecord>) => void;
  /** Called to create the new record */
  onAdd: () => void;
  /** Optional name of the zone to display in the dialog */
  zoneName?: string;
}

/**
 * Dialog that collects fields to create a DNS record and forwards the
 * create action via `onAdd`.
 */
export function AddRecordDialog({ open, onOpenChange, record, onRecordChange, onAdd, zoneName }: AddRecordDialogProps) {
  const ttlValue = record.ttl === 1 ? 'auto' : record.ttl;
  const isCustomTTL =
    ttlValue !== undefined && !TTL_PRESETS.includes(ttlValue as any);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4 mr-2" />
          Add Record
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add DNS Record</DialogTitle>
          <DialogDescription>
            Create a new DNS record for {zoneName}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Type</Label>
              <Select
                value={record.type}
                onValueChange={(value: string) =>
                  onRecordChange({
                    ...record,
                    type: value as RecordType,
                    priority: value === 'MX' ? record.priority : undefined
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECORD_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>TTL</Label>
              <Select
                value={isCustomTTL ? 'custom' : String(ttlValue)}
                onValueChange={(value: string) => {
                  if (value === 'custom') {
                    onRecordChange({ ...record, ttl: 300 });
                  } else {
                    onRecordChange({
                      ...record,
                      ttl: value === 'auto' ? 'auto' : Number(value)
                    });
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TTL_PRESETS.map((ttl) => (
                    <SelectItem key={ttl} value={String(ttl)}>
                      {ttl === 'auto' ? 'Auto' : ttl}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
              {isCustomTTL && (
                <Input
                  type="number"
                  value={typeof record.ttl === 'number' ? record.ttl : ''}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    onRecordChange({
                      ...record,
                      ttl: Number.isNaN(n) ? 300 : n
                    });
                  }}
                />
              )}
            </div>
          </div>
          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              value={record.name}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onRecordChange({
                ...record,
                name: e.target.value
              })}
              placeholder="e.g., www or @ for root"
            />
          </div>
          <div className="space-y-2">
            <Label>Content</Label>
            <Input
              value={record.content}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onRecordChange({
                ...record,
                content: e.target.value
              })}
              placeholder="e.g., 192.168.1.1"
            />
          </div>
          {record.type === 'MX' && (
            <div className="space-y-2">
              <Label>Priority</Label>
              <Input
                type="number"
                value={record.priority || ''}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const n = Number.parseInt(e.target.value, 10);
                  onRecordChange({
                    ...record,
                    priority: Number.isNaN(n) ? undefined : n
                  });
                }}
              />
            </div>
          )}
          {(record.type === 'A' || record.type === 'AAAA' || record.type === 'CNAME') && (
            <div className="flex items-center space-x-2">
              <Switch
                checked={record.proxied || false}
                onCheckedChange={(checked: boolean) =>
                  onRecordChange({
                    ...record,
                    proxied: checked
                  })
                }
              />
              <Label>Proxied through Cloudflare</Label>
            </div>
          )}
          <Button onClick={onAdd} className="w-full">
            Create Record
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
